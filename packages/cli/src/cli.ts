import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  createSnapshot,
  DEFAULT_CORRELATOR,
  findLockfiles,
  LockfileError,
  readManifests,
  SubmissionError,
  submitSnapshot,
} from '@bun-lock-submission/core';

import packageJson from '../package.json' with { type: 'json' };

import type { Layout, LockfileReport, Snapshot } from '@bun-lock-submission/core';

const USAGE = `Usage: bun-lock-submission <command> [options] [lockfile...]

Submits the dependencies in Bun lockfiles (bun.lock) to GitHub's dependency
graph, so Dependabot alerts cover transitive dependencies.

Commands:
  snapshot   Print the snapshot as JSON, without submitting it
  submit     Submit the snapshot to GitHub
  clear      Submit an empty snapshot, removing what the correlator submitted

Lockfiles default to every bun.lock under the current directory, outside
node_modules. Manifests are named by their path in the repository.

Options:
  --layout <name>          lockfile (default): report against each bun.lock
                           workspaces: report against each workspace package.json
  --include-exact-pins     Also submit direct dependencies that package.json pins to
                           the locked version, which GitHub already alerts on
  --exclude <patterns>     Leave out packages by name, comma-separated; * matches
                           anything (repeatable)
  --correlator <name>      Snapshot group to replace (default: ${DEFAULT_CORRELATOR})
  --repository <owner/name>  Default: $GITHUB_REPOSITORY, then the origin remote
  --sha <sha>              Default: $GITHUB_SHA, then HEAD
  --ref <ref>              Default: $GITHUB_REF, then the current branch. A bare
                           name such as main means refs/heads/main
  --token <token>          Default: $GITHUB_TOKEN, then $GH_TOKEN, then \`gh auth token\`
  --api-url <url>          Default: $GITHUB_API_URL, then https://api.github.com
  --output <file>          snapshot: write the JSON to a file instead of stdout
  -h, --help               Show this help
  -v, --version            Show the version
`;

const COMMANDS = ['snapshot', 'submit', 'clear'] as const;
type Command = (typeof COMMANDS)[number];

export type CliContext = {
  env: Record<string, string | undefined>;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch?: typeof globalThis.fetch;
  /** Runs a command and returns its trimmed output, or undefined when it fails. */
  exec?: (file: string, args: string[], cwd: string) => string | undefined;
};

class UsageError extends Error {}

/** Runs the CLI and returns its exit code. */
export async function main(argv: string[], context: CliContext): Promise<number> {
  const { stdout, stderr } = context;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        layout: { type: 'string' },
        'include-exact-pins': { type: 'boolean' },
        exclude: { type: 'string', multiple: true },
        correlator: { type: 'string' },
        repository: { type: 'string' },
        sha: { type: 'string' },
        ref: { type: 'string' },
        token: { type: 'string' },
        'api-url': { type: 'string' },
        output: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
    if (values.version) {
      stdout(`${packageJson.version}\n`);
      return 0;
    }
    const [command, ...lockfileArguments] = positionals;
    if (values.help || command === undefined) {
      (values.help ? stdout : stderr)(USAGE);
      return values.help ? 0 : 2;
    }
    if (!isCommand(command)) {
      throw new UsageError(`Unknown command "${command}".`);
    }
    const layout = values.layout ?? 'lockfile';
    if (layout !== 'lockfile' && layout !== 'workspaces') {
      throw new UsageError(`--layout must be "lockfile" or "workspaces", not "${layout}".`);
    }
    if (command === 'clear' && lockfileArguments.length > 0) {
      throw new UsageError('clear takes no lockfiles.');
    }

    const exec = context.exec ?? runCommand;
    const { env, cwd } = context;
    const root = exec('git', ['rev-parse', '--show-toplevel'], cwd) ?? cwd;
    const sha = values.sha ?? env.GITHUB_SHA ?? exec('git', ['rev-parse', 'HEAD'], cwd);
    const givenRef =
      values.ref ?? env.GITHUB_REF ?? exec('git', ['symbolic-ref', '-q', 'HEAD'], cwd);
    // GitHub needs a fully qualified ref; read a bare name such as `main` as a branch.
    const ref = givenRef && !givenRef.startsWith('refs/') ? `refs/heads/${givenRef}` : givenRef;
    if (!sha || !ref) {
      throw new UsageError(
        'Cannot tell which commit and ref the lockfiles belong to. Run inside a git checkout, or pass --sha and --ref.',
      );
    }

    let manifests: Snapshot['manifests'] = {};
    if (command !== 'clear') {
      const lockfiles = findInputLockfiles(root, cwd, lockfileArguments, stderr);
      const result = readManifests(root, lockfiles, {
        layout: layout satisfies Layout,
        includeExactPins: values['include-exact-pins'] ?? false,
        exclude: (values.exclude ?? []).flatMap((value) =>
          value
            .split(',')
            .map((pattern) => pattern.trim())
            .filter(Boolean),
        ),
      });
      manifests = result.manifests;
      for (const warning of result.warnings) {
        stderr(`Warning: ${warning}\n`);
      }
      stderr(describeReports(result.reports));
    }

    const snapshot = createSnapshot({
      manifests,
      sha,
      ref,
      correlator: values.correlator ?? DEFAULT_CORRELATOR,
      jobId: env.GITHUB_RUN_ID ?? `cli-${Date.now()}`,
      detectorVersion: packageJson.version,
    });

    if (command === 'snapshot') {
      const json = `${JSON.stringify(snapshot, null, 2)}\n`;
      if (values.output) {
        writeFileSync(resolve(cwd, values.output), json);
        stderr(`Wrote the snapshot to ${values.output}.\n`);
      } else {
        stdout(json);
      }
      return 0;
    }

    const repository =
      values.repository ??
      env.GITHUB_REPOSITORY ??
      repositoryFromRemote(exec('git', ['remote', 'get-url', 'origin'], cwd));
    if (!repository) {
      throw new UsageError(
        'Cannot tell which repository to submit to. Pass --repository owner/name.',
      );
    }
    const token =
      values.token ?? env.GITHUB_TOKEN ?? env.GH_TOKEN ?? exec('gh', ['auth', 'token'], cwd);
    if (!token) {
      throw new UsageError(
        'No GitHub token. Pass --token, set GITHUB_TOKEN or GH_TOKEN, or sign in with `gh auth login`.',
      );
    }
    const response = await submitSnapshot(snapshot, {
      repository,
      token,
      apiUrl: values['api-url'] ?? env.GITHUB_API_URL ?? 'https://api.github.com',
      ...(context.fetch ? { fetch: context.fetch } : {}),
    });
    const what =
      command === 'clear'
        ? `Cleared the "${snapshot.job.correlator}" snapshot`
        : `Submitted ${Object.keys(manifests).length} manifest(s)`;
    stderr(`${what} to ${repository} at ${ref}: ${response.result} (snapshot ${response.id}).\n`);
    if (response.result === 'ACCEPTED') {
      stderr(
        'GitHub stored the snapshot but did not apply it. That is expected for a ref other than the default branch; otherwise a newer snapshot already exists for this correlator.\n',
      );
    }
    return response.result === 'INVALID' ? 1 : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`${error.message}\nRun bun-lock-submission --help for usage.\n`);
      return 2;
    }
    if (error instanceof LockfileError || error instanceof SubmissionError) {
      stderr(`${error.message}\n`);
      return 1;
    }
    if (
      error instanceof TypeError &&
      'code' in error &&
      String(error.code).startsWith('ERR_PARSE_ARGS')
    ) {
      stderr(`${error.message}\nRun bun-lock-submission --help for usage.\n`);
      return 2;
    }
    throw error;
  }
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

function findInputLockfiles(
  root: string,
  cwd: string,
  paths: string[],
  stderr: (text: string) => void,
): string[] {
  if (paths.length > 0) {
    return paths.map((path) => relative(root, resolve(cwd, path)));
  }
  const { lockfiles, binaryOnly } = findLockfiles(root, cwd);
  for (const path of binaryOnly) {
    stderr(
      `Warning: ${path} is the legacy binary lockfile, which cannot be read. Run \`bun install --save-text-lockfile\` to write bun.lock.\n`,
    );
  }
  if (lockfiles.length === 0) {
    throw new LockfileError(`No bun.lock found under ${cwd}.`);
  }
  return lockfiles;
}

function describeReports(reports: readonly LockfileReport[]): string {
  return reports
    .map(({ path, stats }) => {
      const details = [
        `${stats.direct} direct`,
        `${stats.indirect} transitive`,
        ...(stats.skippedExactPins > 0
          ? [`${stats.skippedExactPins} exact pins left to package.json`]
          : []),
        ...(stats.excluded > 0 ? [`${stats.excluded} excluded`] : []),
      ];
      return `${path}: ${stats.packages} packages (${details.join(', ')})\n`;
    })
    .join('');
}

/** Reads `owner/name` from an SSH or HTTPS remote URL. */
export function repositoryFromRemote(url: string | undefined): string | undefined {
  const match = url?.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return match?.[1];
}

function runCommand(file: string, args: string[], cwd: string): string | undefined {
  try {
    return (
      execFileSync(file, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

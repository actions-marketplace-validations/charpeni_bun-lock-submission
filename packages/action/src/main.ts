import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  createSnapshot,
  DEFAULT_CORRELATOR,
  findLockfiles,
  readManifests,
  submitSnapshot,
} from '@bun-lock-submission/core';

import packageJson from '../package.json' with { type: 'json' };
import {
  annotation,
  appendSummary,
  getBooleanInput,
  getInput,
  getMultilineInput,
  setOutput,
} from './workflow-commands.ts';

import type { LockfileReport } from '@bun-lock-submission/core';

type Env = Record<string, string | undefined>;

export type RunOptions = {
  write: (text: string) => void;
  fetch?: typeof globalThis.fetch;
};

/** Runs the action and returns its exit code. */
export async function run(env: Env, { write, fetch }: RunOptions): Promise<number> {
  try {
    const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
    const directory = resolve(workspace, getInput(env, 'working-directory') || '.');
    const layout = getInput(env, 'layout') || 'lockfile';
    if (layout !== 'lockfile' && layout !== 'workspaces') {
      throw new Error(`Input "layout" must be "lockfile" or "workspaces", not "${layout}".`);
    }
    const correlator = getInput(env, 'correlator') || DEFAULT_CORRELATOR;
    const dryRun = getBooleanInput(env, 'dry-run');

    const listed = getMultilineInput(env, 'lockfiles');
    let lockfiles: string[];
    if (listed.length > 0) {
      lockfiles = listed.map((path) => relative(workspace, resolve(directory, path)));
    } else {
      const found = findLockfiles(workspace, directory);
      for (const path of found.binaryOnly) {
        write(
          annotation(
            'warning',
            `${path} is the legacy binary lockfile, which cannot be read. Run \`bun install --save-text-lockfile\` to write bun.lock.`,
          ),
        );
      }
      lockfiles = found.lockfiles;
    }
    if (lockfiles.length === 0) {
      throw new Error(
        `No bun.lock found under ${relative(workspace, directory) || 'the repository root'}. To remove a previous submission, run \`bunx bun-lock-submission clear\`.`,
      );
    }

    const { manifests, reports, warnings } = readManifests(workspace, lockfiles, {
      layout,
      includeExactPins: getBooleanInput(env, 'include-exact-pins'),
      exclude: getMultilineInput(env, 'exclude').flatMap((line) =>
        line
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean),
      ),
    });
    for (const warning of warnings) {
      write(annotation('warning', warning));
    }

    const { sha, ref } = commitOf(env);
    const repository = required(env, 'GITHUB_REPOSITORY');
    const runId = env.GITHUB_RUN_ID || `local-${Date.now()}`;
    const snapshot = createSnapshot({
      manifests,
      sha,
      ref,
      correlator,
      jobId: `${runId}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`,
      jobUrl: env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`
        : undefined,
      detectorVersion: packageJson.version,
    });

    const packageCount = reports.reduce((total, report) => total + report.stats.packages, 0);
    setOutput(env, 'manifests', String(Object.keys(manifests).length));
    setOutput(env, 'packages', String(packageCount));
    write(describeReports(reports));

    if (dryRun) {
      const path = join(env.RUNNER_TEMP ?? workspace, 'bun-lock-submission-snapshot.json');
      writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
      setOutput(env, 'snapshot-path', path);
      setOutput(env, 'result', 'DRY_RUN');
      write(`Dry run: wrote the snapshot to ${path} without submitting it.\n`);
      appendSummary(env, summary(reports, 'Dry run, not submitted', correlator));
      return 0;
    }

    const token = getInput(env, 'token');
    if (!token) {
      throw new Error(
        'Input "token" is empty. It defaults to github.token, which needs `contents: write`.',
      );
    }
    const response = await submitSnapshot(snapshot, {
      repository,
      token,
      apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
      ...(fetch ? { fetch } : {}),
    });
    setOutput(env, 'result', response.result);
    setOutput(env, 'snapshot-id', String(response.id));
    write(
      `Submitted ${Object.keys(manifests).length} manifest(s) to ${repository} at ${ref}: ${response.result} (snapshot ${response.id}).\n`,
    );
    if (response.result === 'ACCEPTED') {
      write(
        annotation(
          'notice',
          `GitHub stored the snapshot for ${ref} but did not apply it. Dependabot alerts follow the default branch; otherwise a newer snapshot already exists for the "${correlator}" correlator.`,
        ),
      );
    }
    appendSummary(env, summary(reports, response.result, correlator));
    if (response.result === 'INVALID') {
      write(annotation('error', `GitHub rejected the snapshot as invalid: ${response.message}`));
      return 1;
    }
    return 0;
  } catch (error) {
    write(annotation('error', error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

/**
 * The commit and ref to report. A pull request from this repository reports its head, like
 * GitHub's own submission actions, rather than the merge commit it checked out. A pull
 * request from a fork keeps the merge ref: its head branch name means a different branch
 * here, and reporting `refs/heads/main` from a fork would replace this repository's own.
 */
function commitOf(env: Env): { sha: string; ref: string } {
  if (env.GITHUB_EVENT_NAME === 'pull_request' && env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as {
      pull_request?: { head?: { sha?: string; ref?: string; repo?: { full_name?: string } } };
    };
    const head = event.pull_request?.head;
    if (head?.sha && head.ref && head.repo?.full_name === env.GITHUB_REPOSITORY) {
      return { sha: head.sha, ref: `refs/heads/${head.ref}` };
    }
  }
  return { sha: required(env, 'GITHUB_SHA'), ref: required(env, 'GITHUB_REF') };
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not set; this action must run in GitHub Actions.`);
  }
  return value;
}

function describeReports(reports: readonly LockfileReport[]): string {
  return reports
    .map(
      ({ path, stats }) =>
        `${path}: ${stats.packages} packages (${stats.direct} direct, ${stats.indirect} transitive, ${stats.skippedExactPins} exact pins left to package.json, ${stats.excluded} excluded)\n`,
    )
    .join('');
}

function summary(reports: readonly LockfileReport[], result: string, correlator: string): string {
  const rows = reports.map(
    ({ path, stats }) =>
      `| \`${path}\` | ${stats.packages} | ${stats.direct} | ${stats.indirect} | ${stats.skippedExactPins} | ${stats.excluded} |`,
  );
  return [
    '### Bun lockfile dependency submission',
    '',
    `Result: **${result}** (correlator \`${correlator}\`)`,
    '',
    '| Lockfile | Packages | Direct | Transitive | Exact pins left to package.json | Excluded |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
  ].join('\n');
}

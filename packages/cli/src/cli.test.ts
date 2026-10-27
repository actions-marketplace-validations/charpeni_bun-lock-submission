import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import packageJson from '../package.json' with { type: 'json' };
import { main, repositoryFromRemote } from './cli.ts';

import type { CliContext } from './cli.ts';

const FIXTURE = fileURLToPath(new URL('../../core/fixtures/handwritten/bun.lock', import.meta.url));
const SHA = 'c'.repeat(40);

/** A checkout with the fixture lockfile at `apps/web/bun.lock`. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), 'bun-lock-submission-cli-'));
  mkdirSync(join(root, 'apps/web'), { recursive: true });
  copyFileSync(FIXTURE, join(root, 'apps/web/bun.lock'));
  return root;
}

function run(
  argv: string[],
  overrides: Partial<CliContext> & { git?: Record<string, string>; ghToken?: string } = {},
) {
  let stdout = '';
  let stderr = '';
  const { git = {}, ghToken, ...context } = overrides;
  const exitCode = main(argv, {
    env: {},
    cwd: tmpdir(),
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    exec: (file, args) =>
      file === 'git' ? git[args.join(' ')] : file === 'gh' ? ghToken : undefined,
    ...context,
  });
  return exitCode.then((code) => ({ code, stdout, stderr }));
}

function fakeFetch(result: string, status = 201, body?: unknown) {
  const requests: { url: string; authorization: string | null; body: unknown }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      authorization: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body)),
    });
    return Response.json(
      body ?? { id: 99, created_at: '2026-10-27T12:00:00Z', result, message: 'details' },
      { status },
    );
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe('usage', () => {
  test('prints the version', async () => {
    expect(await run(['--version'])).toEqual({
      code: 0,
      stdout: `${packageJson.version}\n`,
      stderr: '',
    });
  });

  test('prints usage and fails without a command', async () => {
    const { code, stderr } = await run([]);
    expect(code).toBe(2);
    expect(stderr).toContain('Usage: bun-lock-submission <command>');
  });

  test('rejects unknown commands, options and layouts', async () => {
    expect((await run(['publish'])).code).toBe(2);
    expect((await run(['snapshot', '--nope'])).code).toBe(2);
    expect((await run(['snapshot', '--layout', 'flat'])).stderr).toContain('--layout must be');
  });
});

describe('snapshot', () => {
  test('names manifests by their path from the git root, even from a subdirectory', async () => {
    const root = checkout();
    const { code, stdout, stderr } = await run(['snapshot'], {
      cwd: join(root, 'apps'),
      git: {
        'rev-parse --show-toplevel': root,
        'rev-parse HEAD': SHA,
        'symbolic-ref -q HEAD': 'refs/heads/main',
      },
    });
    expect(code).toBe(0);
    const snapshot = JSON.parse(stdout);
    expect(snapshot.sha).toBe(SHA);
    expect(snapshot.ref).toBe('refs/heads/main');
    expect(snapshot.job.correlator).toBe('bun-lock-submission');
    expect(snapshot.detector.version).toBe(packageJson.version);
    expect(Object.keys(snapshot.manifests)).toEqual(['apps/web/bun.lock']);
    expect(stderr).toBe(
      'apps/web/bun.lock: 10 packages (4 direct, 6 transitive, 4 exact pins left to package.json)\n',
    );
  });

  test('takes explicit lockfiles, layout, exclusions and context', async () => {
    const root = checkout();
    const { code, stdout } = await run(
      [
        'snapshot',
        'apps/web/bun.lock',
        '--layout',
        'workspaces',
        '--exclude',
        '@private/*',
        '--sha',
        SHA,
        '--ref',
        'refs/heads/release',
        '--correlator',
        'web',
      ],
      { cwd: root },
    );
    expect(code).toBe(0);
    const snapshot = JSON.parse(stdout);
    expect(snapshot.ref).toBe('refs/heads/release');
    expect(snapshot.job.correlator).toBe('web');
    expect(Object.keys(snapshot.manifests).toSorted()).toEqual([
      'apps/web/package.json',
      'apps/web/packages/app/package.json',
      'apps/web/packages/lib/package.json',
    ]);
    const submitted = Object.values(snapshot.manifests).flatMap((manifest) =>
      Object.keys((manifest as { resolved: object }).resolved),
    );
    expect(submitted).toContain('pkg:npm/ms@2.1.3');
    expect(submitted).not.toContain('pkg:npm/%40private/sdk@1.0.0');
  });

  test('writes to a file with --output', async () => {
    const root = checkout();
    const { code, stdout } = await run(
      ['snapshot', '--output', 'snapshot.json', '--sha', SHA, '--ref', 'refs/heads/main'],
      {
        cwd: root,
      },
    );
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(JSON.parse(readFileSync(join(root, 'snapshot.json'), 'utf8')).sha).toBe(SHA);
  });

  test('fails without a commit to attach the snapshot to', async () => {
    const { code, stderr } = await run(['snapshot'], { cwd: checkout() });
    expect(code).toBe(2);
    expect(stderr).toContain('pass --sha and --ref');
  });

  test('fails when there is no lockfile', async () => {
    const { code, stderr } = await run(['snapshot', '--sha', SHA, '--ref', 'refs/heads/main'], {
      cwd: mkdtempSync(join(tmpdir(), 'empty-')),
    });
    expect(code).toBe(1);
    expect(stderr).toContain('No bun.lock found');
  });
});

/** What `git` answers inside a checkout of owner/repo on main. */
function gitInCheckout(root: string): Record<string, string> {
  return {
    'rev-parse --show-toplevel': root,
    'rev-parse HEAD': SHA,
    'symbolic-ref -q HEAD': 'refs/heads/main',
    'remote get-url origin': 'git@github.com:owner/repo.git',
  };
}

describe('submit and clear', () => {
  test('submits to the origin repository with the environment token', async () => {
    const root = checkout();
    const { fetch, requests } = fakeFetch('SUCCESS');
    const { code, stderr } = await run(['submit'], {
      cwd: root,
      env: { GH_TOKEN: 't' },
      git: gitInCheckout(root),
      fetch,
    });
    expect(code).toBe(0);
    expect(requests[0]?.url).toBe(
      'https://api.github.com/repos/owner/repo/dependency-graph/snapshots',
    );
    expect(Object.keys((requests[0]!.body as { manifests: object }).manifests)).toEqual([
      'apps/web/bun.lock',
    ]);
    expect(stderr).toContain(
      'Submitted 1 manifest(s) to owner/repo at refs/heads/main: SUCCESS (snapshot 99).',
    );
  });

  test('explains an ACCEPTED result', async () => {
    const root = checkout();
    const { fetch } = fakeFetch('ACCEPTED');
    const { code, stderr } = await run(['submit'], {
      cwd: root,
      env: { GITHUB_TOKEN: 't' },
      git: gitInCheckout(root),
      fetch,
    });
    expect(code).toBe(0);
    expect(stderr).toContain('did not apply it');
  });

  test('clears a correlator with an empty snapshot', async () => {
    const root = checkout();
    const { fetch, requests } = fakeFetch('SUCCESS');
    const { code, stderr } = await run(['clear', '--correlator', 'web'], {
      cwd: root,
      env: { GITHUB_TOKEN: 't' },
      git: gitInCheckout(root),
      fetch,
    });
    expect(code).toBe(0);
    expect(requests[0]?.body).toMatchObject({ job: { correlator: 'web' }, manifests: {} });
    expect(stderr).toContain('Cleared the "web" snapshot');
  });

  test('fails without a token', async () => {
    const root = checkout();
    const { code, stderr } = await run(['submit'], { cwd: root, git: gitInCheckout(root) });
    expect(code).toBe(2);
    expect(stderr).toContain('No GitHub token');
  });
});

test('repositoryFromRemote reads SSH and HTTPS remotes', () => {
  expect(repositoryFromRemote('git@github.com:owner/repo.git')).toBe('owner/repo');
  expect(repositoryFromRemote('https://github.com/owner/repo')).toBe('owner/repo');
  expect(repositoryFromRemote('ssh://git@ghe.example.com/owner/repo.git/')).toBe('owner/repo');
  expect(repositoryFromRemote(undefined)).toBeUndefined();
});

describe('options', () => {
  const context = { sha: SHA, ref: 'refs/heads/main' };

  test('includes exact pins on request', async () => {
    const { code, stdout, stderr } = await run(
      ['snapshot', '--include-exact-pins', '--sha', context.sha, '--ref', context.ref],
      { cwd: checkout() },
    );
    expect(code).toBe(0);
    expect(stderr).toBe('apps/web/bun.lock: 14 packages (8 direct, 6 transitive)\n');
    expect(JSON.parse(stdout).manifests['apps/web/bun.lock'].resolved).toHaveProperty([
      'pkg:npm/left-pad@1.3.0',
    ]);
  });

  test('splits --exclude on commas and repeats, like the action', async () => {
    const { stderr } = await run(
      [
        'snapshot',
        '--exclude',
        '@private/*, chalk',
        '--exclude',
        'emoji-regex',
        '--sha',
        SHA,
        '--ref',
        'refs/heads/main',
      ],
      { cwd: checkout() },
    );
    expect(stderr).toContain('3 excluded');
  });

  test('reads a bare --ref as a branch', async () => {
    const { stdout } = await run(['snapshot', '--sha', SHA, '--ref', 'main'], { cwd: checkout() });
    expect(JSON.parse(stdout).ref).toBe('refs/heads/main');
  });

  test('takes the commit, ref and run from the GitHub Actions environment', async () => {
    const { stdout } = await run(['snapshot'], {
      cwd: checkout(),
      env: { GITHUB_SHA: SHA, GITHUB_REF: 'refs/tags/v1.0.0', GITHUB_RUN_ID: '77' },
    });
    expect(JSON.parse(stdout)).toMatchObject({
      sha: SHA,
      ref: 'refs/tags/v1.0.0',
      job: { id: '77' },
    });
  });

  test('names explicit lockfiles from the git root, given relative to the current directory', async () => {
    const root = checkout();
    const { stdout } = await run(['snapshot', 'web/bun.lock'], {
      cwd: join(root, 'apps'),
      git: gitInCheckout(root),
    });
    expect(Object.keys(JSON.parse(stdout).manifests)).toEqual(['apps/web/bun.lock']);
  });

  test('warns about binary-only lockfiles and newer lockfile versions', async () => {
    const root = checkout();
    mkdirSync(join(root, 'legacy'));
    writeFileSync(join(root, 'legacy/bun.lockb'), 'binary');
    mkdirSync(join(root, 'future'));
    writeFileSync(
      join(root, 'future/bun.lock'),
      JSON.stringify({ lockfileVersion: 9, workspaces: { '': {} }, packages: {} }),
    );
    const { code, stderr } = await run(['snapshot', '--sha', SHA, '--ref', 'refs/heads/main'], {
      cwd: root,
    });
    expect(code).toBe(0);
    expect(stderr).toContain('Warning: legacy/bun.lockb is the legacy binary lockfile');
    expect(stderr).toContain('Warning: future/bun.lock uses lockfileVersion 9');
  });

  test('prints help on stdout', async () => {
    const { code, stdout } = await run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: bun-lock-submission <command>');
  });

  test('rejects lockfiles for clear', async () => {
    const { code, stderr } = await run(['clear', 'bun.lock']);
    expect(code).toBe(2);
    expect(stderr).toContain('clear takes no lockfiles.');
  });
});

/** Submits from a checkout of owner/repo and returns the request GitHub received. */
const submit = async (argv: string[], overrides: Parameters<typeof run>[1] = {}) => {
  const root = checkout();
  const { fetch, requests } = fakeFetch('SUCCESS');
  const result = await run(['submit', ...argv], {
    cwd: root,
    git: gitInCheckout(root),
    fetch,
    ...overrides,
  });
  return { ...result, request: requests[0] };
};

describe('where submit sends the snapshot', () => {
  test('prefers --repository, then GITHUB_REPOSITORY, then the origin remote', async () => {
    const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'env/repo' };
    expect((await submit(['--repository', 'flag/repo'], { env })).request?.url).toContain(
      '/repos/flag/repo/',
    );
    expect((await submit([], { env })).request?.url).toContain('/repos/env/repo/');
    expect((await submit([], { env: { GITHUB_TOKEN: 't' } })).request?.url).toContain(
      '/repos/owner/repo/',
    );
  });

  test('prefers --token, then GITHUB_TOKEN, then GH_TOKEN, then gh auth token', async () => {
    const env = { GITHUB_TOKEN: 'github', GH_TOKEN: 'gh-env' };
    expect((await submit(['--token', 'flag'], { env })).request?.authorization).toBe('Bearer flag');
    expect((await submit([], { env })).request?.authorization).toBe('Bearer github');
    expect((await submit([], { env: { GH_TOKEN: 'gh-env' } })).request?.authorization).toBe(
      'Bearer gh-env',
    );
    expect((await submit([], { ghToken: 'gh-cli' })).request?.authorization).toBe('Bearer gh-cli');
  });

  test('uses --api-url or GITHUB_API_URL for GitHub Enterprise Server', async () => {
    const env = { GITHUB_TOKEN: 't', GITHUB_API_URL: 'https://ghe.example.com/api/v3' };
    expect((await submit([], { env })).request?.url).toBe(
      'https://ghe.example.com/api/v3/repos/owner/repo/dependency-graph/snapshots',
    );
    expect(
      (await submit(['--api-url', 'https://other.example.com/api/v3'], { env })).request?.url,
    ).toStartWith('https://other.example.com/api/v3/');
  });

  test('fails without a repository', async () => {
    const root = checkout();
    const { code, stderr } = await run(['submit', '--sha', SHA, '--ref', 'refs/heads/main'], {
      cwd: root,
      env: { GITHUB_TOKEN: 't' },
    });
    expect(code).toBe(2);
    expect(stderr).toContain('Pass --repository owner/name.');
  });
});

/** Submits from a checkout of owner/repo with the given GitHub response. */
const outcome = async (fetch: typeof globalThis.fetch) => {
  const root = checkout();
  return run(['submit'], {
    cwd: root,
    env: { GITHUB_TOKEN: 't' },
    git: gitInCheckout(root),
    fetch,
  });
};

describe('submit outcomes', () => {
  test('fails on an INVALID result', async () => {
    const { code, stderr } = await outcome(fakeFetch('INVALID').fetch);
    expect(code).toBe(1);
    expect(stderr).toContain(': INVALID (snapshot 99).');
  });

  test('fails with GitHub’s message on an HTTP error', async () => {
    const { code, stderr } = await outcome(fakeFetch('', 404, { message: 'Not Found' }).fetch);
    expect(code).toBe(1);
    expect(stderr).toContain('GitHub rejected the snapshot (HTTP 404): Not Found.');
  });

  test('fails with a message when GitHub cannot be reached', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const { code, stderr } = await outcome(fetch);
    expect(code).toBe(1);
    expect(stderr).toContain('Could not reach https://api.github.com/');
  });
});

test('asks for --sha and --ref outside a git checkout', async () => {
  let stderr = '';
  const code = await main(['snapshot'], {
    env: {},
    cwd: checkout(),
    stdout: () => {},
    stderr: (text) => (stderr += text),
  });
  expect(code).toBe(2);
  expect(stderr).toContain('pass --sha and --ref');
});

test('reads the commit, branch, root and origin from a real git checkout', async () => {
  const root = checkout();
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  git('init', '-q', '-b', 'release');
  git('remote', 'add', 'origin', 'https://github.com/real/checkout.git');
  git('add', '.');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-q',
    '-m',
    'Lockfile',
  );
  const { fetch, requests } = fakeFetch('SUCCESS');
  let stderr = '';
  const code = await main(['submit'], {
    env: { GITHUB_TOKEN: 't' },
    cwd: join(root, 'apps/web'),
    stdout: () => {},
    stderr: (text) => (stderr += text),
    fetch,
  });
  expect({ code, stderr }).toMatchObject({ code: 0 });
  expect(requests[0]?.url).toBe(
    'https://api.github.com/repos/real/checkout/dependency-graph/snapshots',
  );
  expect(requests[0]?.body).toMatchObject({
    sha: git('rev-parse', 'HEAD'),
    ref: 'refs/heads/release',
  });
  expect(Object.keys((requests[0]!.body as { manifests: object }).manifests)).toEqual([
    'apps/web/bun.lock',
  ]);
});

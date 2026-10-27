import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './main.ts';

const FIXTURE = fileURLToPath(new URL('../../core/fixtures/handwritten/bun.lock', import.meta.url));
const SHA = 'd'.repeat(40);

/** A runner environment around a checkout with lockfiles at `bun.lock` and `apps/web/bun.lock`. */
function runner(inputs: Record<string, string> = {}, extra: Record<string, string> = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'bun-lock-submission-action-'));
  mkdirSync(join(workspace, 'apps/web'), { recursive: true });
  copyFileSync(FIXTURE, join(workspace, 'bun.lock'));
  copyFileSync(FIXTURE, join(workspace, 'apps/web/bun.lock'));
  const temp = mkdtempSync(join(tmpdir(), 'runner-temp-'));
  const env: Record<string, string> = {
    GITHUB_WORKSPACE: workspace,
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_SHA: SHA,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_OUTPUT: join(temp, 'output'),
    GITHUB_STEP_SUMMARY: join(temp, 'summary'),
    RUNNER_TEMP: temp,
    INPUT_TOKEN: 'secret',
    ...Object.fromEntries(
      Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value]),
    ),
    ...extra,
  };
  writeFileSync(env.GITHUB_OUTPUT!, '');
  let log = '';
  const outputs = () => {
    const parsed: Record<string, string> = {};
    const pattern = /^(.+?)<<(ghadelimiter_[\w-]+)\n([\s\S]*?)\n\2$/gm;
    for (const match of readFileSync(env.GITHUB_OUTPUT!, 'utf8').matchAll(pattern)) {
      parsed[match[1]!] = match[3]!;
    }
    return parsed;
  };
  return {
    env,
    workspace,
    outputs,
    log: () => log,
    write: (text: string) => (log += text),
    summary: () => readFileSync(env.GITHUB_STEP_SUMMARY!, 'utf8'),
  };
}

function fakeFetch(
  result = 'SUCCESS',
  response: Record<string, unknown> = {
    id: 5,
    created_at: '2026-10-27T12:00:00Z',
    result,
    message: 'ok',
  },
  status = 201,
) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return Response.json(response, { status });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

/** Runs the action for a pull request event and returns what it submitted. */
const submitFor = async (eventName: string, event: unknown) => {
  const context = runner();
  const eventPath = join(context.env.RUNNER_TEMP!, 'event.json');
  writeFileSync(eventPath, JSON.stringify(event));
  Object.assign(context.env, {
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REF: 'refs/pull/1/merge',
  });
  const { fetch, requests } = fakeFetch('ACCEPTED');
  expect(await run(context.env, { write: context.write, fetch })).toBe(0);
  return { body: requests[0]?.body, log: context.log() };
};

describe('run', () => {
  test('submits every lockfile in one snapshot and sets outputs', async () => {
    const context = runner();
    const { fetch, requests } = fakeFetch();
    expect(await run(context.env, { write: context.write, fetch })).toBe(0);

    expect(requests[0]?.url).toBe(
      'https://api.github.com/repos/owner/repo/dependency-graph/snapshots',
    );
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer secret');
    const snapshot = requests[0]!.body;
    expect(Object.keys(snapshot.manifests as object)).toEqual(['apps/web/bun.lock', 'bun.lock']);
    expect(snapshot).toMatchObject({
      sha: SHA,
      ref: 'refs/heads/main',
      job: {
        correlator: 'bun-lock-submission',
        id: '123-2',
        html_url: 'https://github.com/owner/repo/actions/runs/123',
      },
    });
    expect(context.outputs()).toEqual({
      manifests: '2',
      packages: '20',
      result: 'SUCCESS',
      'snapshot-id': '5',
    });
    expect(context.summary()).toContain('| `bun.lock` | 10 | 4 | 6 | 4 | 0 |');
  });

  test('honors working-directory, lockfiles, layout, exclusions and correlator', async () => {
    const context = runner({
      'working-directory': 'apps',
      lockfiles: 'web/bun.lock',
      layout: 'workspaces',
      exclude: '@private/*, nothing-else',
      correlator: 'web',
    });
    const { fetch, requests } = fakeFetch();
    expect(await run(context.env, { write: context.write, fetch })).toBe(0);
    const snapshot = requests[0]!.body;
    expect((snapshot.job as { correlator: string }).correlator).toBe('web');
    expect(Object.keys(snapshot.manifests as object).toSorted()).toEqual([
      'apps/web/package.json',
      'apps/web/packages/app/package.json',
      'apps/web/packages/lib/package.json',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('%40private');
  });

  describe('pull request events', () => {
    const MERGE_SHA = SHA;
    const HEAD_SHA = 'e'.repeat(40);
    const head = (repository: string, ref = 'feature') => ({
      pull_request: { head: { sha: HEAD_SHA, ref, repo: { full_name: repository } } },
    });

    test('reports the head of a pull request from this repository', async () => {
      const { body, log } = await submitFor('pull_request', head('owner/repo'));
      expect(body).toMatchObject({ sha: HEAD_SHA, ref: 'refs/heads/feature' });
      expect(log).toContain(
        '::notice::GitHub stored the snapshot for refs/heads/feature but did not apply it.',
      );
    });

    test('keeps the merge ref for a fork, even when its branch is named like ours', async () => {
      const { body } = await submitFor('pull_request', head('someone/fork', 'main'));
      expect(body).toMatchObject({ sha: MERGE_SHA, ref: 'refs/pull/1/merge' });
    });

    test('keeps the checked-out commit for pull_request_target and malformed events', async () => {
      expect((await submitFor('pull_request_target', head('owner/repo'))).body).toMatchObject({
        sha: MERGE_SHA,
        ref: 'refs/pull/1/merge',
      });
      expect((await submitFor('pull_request', {})).body).toMatchObject({
        sha: MERGE_SHA,
        ref: 'refs/pull/1/merge',
      });
    });
  });

  test('writes the snapshot to a file in a dry run', async () => {
    const context = runner({ 'dry-run': 'true' });
    const { fetch, requests } = fakeFetch();
    expect(await run(context.env, { write: context.write, fetch })).toBe(0);
    expect(requests).toEqual([]);
    const { result, 'snapshot-path': path } = context.outputs();
    expect(result).toBe('DRY_RUN');
    const snapshot = JSON.parse(readFileSync(path!, 'utf8'));
    expect(Object.keys(snapshot.manifests['bun.lock'].resolved)).toHaveLength(10);
    expect(snapshot.manifests['bun.lock'].resolved).toHaveProperty(['pkg:npm/ms@2.1.3']);
  });

  test('fails with an annotation when nothing can be submitted', async () => {
    const context = runner({ 'working-directory': 'apps/web/missing' });
    mkdirSync(join(context.workspace, 'apps/web/missing'));
    expect(await run(context.env, { write: context.write, fetch: fakeFetch().fetch })).toBe(1);
    expect(context.log()).toStartWith('::error::No bun.lock found under apps/web/missing.');
  });

  test('fails on an invalid input or a rejected submission', async () => {
    const badInput = runner({ layout: 'flat' });
    expect(await run(badInput.env, { write: badInput.write })).toBe(1);
    expect(badInput.log()).toContain('::error::Input "layout" must be');

    const rejected = runner();
    const { fetch } = fakeFetch('', { message: 'Resource not accessible by integration' }, 403);
    expect(await run(rejected.env, { write: rejected.write, fetch })).toBe(1);
    expect(rejected.log()).toContain('contents: write');
  });
});

describe('inputs', () => {
  test('includes exact pins on request', async () => {
    const context = runner({ 'include-exact-pins': 'true', lockfiles: 'bun.lock' });
    const { fetch, requests } = fakeFetch();
    expect(await run(context.env, { write: context.write, fetch })).toBe(0);
    expect(context.outputs().packages).toBe('14');
    expect(
      (requests[0]!.body.manifests as Record<string, { resolved: object }>)['bun.lock']?.resolved,
    ).toHaveProperty(['pkg:npm/left-pad@1.3.0']);
  });

  test('names manifests the same way however lockfiles and exclusions are listed', async () => {
    const context = runner({
      lockfiles: './bun.lock\n\n  apps/web/bun.lock  \n',
      exclude: '@private/*\nchalk',
    });
    const { fetch, requests } = fakeFetch();
    expect(await run(context.env, { write: context.write, fetch })).toBe(0);
    expect(Object.keys(requests[0]!.body.manifests as object)).toEqual([
      'bun.lock',
      'apps/web/bun.lock',
    ]);
    expect(context.summary()).toContain('| `bun.lock` | 8 | 2 | 6 | 4 | 2 |');
  });

  test('runs without a run ID, as in local runners', async () => {
    const context = runner({}, { GITHUB_RUN_ID: '' });
    const { fetch, requests } = fakeFetch();
    expect(await run(context.env, { write: context.write, fetch })).toBe(0);
    const job = requests[0]!.body.job as { id: string; html_url?: string };
    expect(job.id).toStartWith('local-');
    expect(job.html_url).toBeUndefined();
  });

  test('submits to GITHUB_API_URL on GitHub Enterprise Server', async () => {
    const context = runner({}, { GITHUB_API_URL: 'https://ghe.example.com/api/v3' });
    const { fetch, requests } = fakeFetch();
    expect(await run(context.env, { write: context.write, fetch })).toBe(0);
    expect(requests[0]?.url).toBe(
      'https://ghe.example.com/api/v3/repos/owner/repo/dependency-graph/snapshots',
    );
  });

  test('rejects invalid inputs and a missing environment', async () => {
    const cases: [Record<string, string>, Record<string, string>, string][] = [
      [{ 'dry-run': 'yes' }, {}, 'Input "dry-run" must be "true" or "false", not "yes".'],
      [{ token: '' }, {}, 'Input "token" is empty.'],
      [{}, { GITHUB_REPOSITORY: '' }, 'GITHUB_REPOSITORY is not set'],
    ];
    for (const [inputs, extra, message] of cases) {
      const context = runner(inputs, extra);
      expect(await run(context.env, { write: context.write, fetch: fakeFetch().fetch })).toBe(1);
      expect(context.log()).toContain(`::error::${message}`);
    }
  });

  test('warns about binary-only lockfiles and newer lockfile versions', async () => {
    const context = runner();
    mkdirSync(join(context.workspace, 'legacy'));
    writeFileSync(join(context.workspace, 'legacy/bun.lockb'), 'binary');
    mkdirSync(join(context.workspace, 'future'));
    writeFileSync(
      join(context.workspace, 'future/bun.lock'),
      JSON.stringify({ lockfileVersion: 9, workspaces: { '': {} }, packages: {} }),
    );
    expect(await run(context.env, { write: context.write, fetch: fakeFetch().fetch })).toBe(0);
    expect(context.log()).toContain('::warning::legacy/bun.lockb is the legacy binary lockfile');
    expect(context.log()).toContain('::warning::future/bun.lock uses lockfileVersion 9');
  });

  test('fails on an INVALID result and reports it', async () => {
    const context = runner();
    expect(
      await run(context.env, { write: context.write, fetch: fakeFetch('INVALID').fetch }),
    ).toBe(1);
    expect(context.outputs().result).toBe('INVALID');
    expect(context.log()).toContain('::error::GitHub rejected the snapshot as invalid: ok');
  });
});

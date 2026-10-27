import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findLockfiles } from './discover.ts';
import { SubmissionError, submitSnapshot } from './github.ts';
import { LockfileError } from './lockfile.ts';
import { createSnapshot, readManifests } from './snapshot.ts';

const minimalLockfile = (version: number) =>
  JSON.stringify({
    lockfileVersion: version,
    workspaces: { '': { name: 'root', dependencies: { ms: '^2.0.0' } } },
    packages: { ms: ['ms@2.1.3', '', {}, 'sha512-x'] },
  });

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'bun-lock-submission-'));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

describe('findLockfiles', () => {
  test('finds lockfiles relative to the root and skips node_modules', () => {
    const root = repository({
      'bun.lock': minimalLockfile(1),
      'apps/web/bun.lock': minimalLockfile(1),
      'apps/web/node_modules/dep/bun.lock': minimalLockfile(1),
      'legacy/bun.lockb': 'binary',
    });
    expect(findLockfiles(root)).toEqual({
      lockfiles: ['apps/web/bun.lock', 'bun.lock'],
      binaryOnly: ['legacy/bun.lockb'],
    });
    expect(findLockfiles(root, join(root, 'apps')).lockfiles).toEqual(['apps/web/bun.lock']);
  });

  test('prefers bun.lock next to a leftover bun.lockb, and skips .git', () => {
    const root = repository({
      'bun.lock': minimalLockfile(1),
      'bun.lockb': 'binary',
      '.git/modules/x/bun.lock': minimalLockfile(1),
    });
    expect(findLockfiles(root)).toEqual({ lockfiles: ['bun.lock'], binaryOnly: [] });
  });
});

describe('readManifests', () => {
  test('merges every lockfile and reports each one', () => {
    const root = repository({
      'bun.lock': minimalLockfile(1),
      'apps/web/bun.lock': minimalLockfile(2),
    });
    const { manifests, reports, warnings } = readManifests(root, ['bun.lock', 'apps/web/bun.lock']);
    expect(Object.keys(manifests)).toEqual(['bun.lock', 'apps/web/bun.lock']);
    expect(
      reports.map((report) => [report.path, report.lockfileVersion, report.stats.packages]),
    ).toEqual([
      ['bun.lock', 1, 1],
      ['apps/web/bun.lock', 2, 1],
    ]);
    expect(warnings).toEqual([]);
  });

  test('warns about lockfile versions newer than the parser knows', () => {
    const root = repository({ 'bun.lock': minimalLockfile(9) });
    expect(readManifests(root, ['bun.lock']).warnings[0]).toContain('lockfileVersion 9');
  });

  test('reads a path written several ways once', () => {
    const root = repository({ 'apps/web/bun.lock': minimalLockfile(1) });
    const { manifests, reports } = readManifests(root, [
      'apps/web/bun.lock',
      './apps/web/bun.lock',
      'apps\\web\\bun.lock',
    ]);
    expect(Object.keys(manifests)).toEqual(['apps/web/bun.lock']);
    expect(reports).toHaveLength(1);
  });

  test('refuses two lockfiles that describe the same package.json', () => {
    const workspaceLockfile = JSON.stringify({
      lockfileVersion: 1,
      workspaces: { '': {}, 'packages/app': { name: 'app', dependencies: { ms: '^2.0.0' } } },
      packages: { ms: ['ms@2.1.3', '', {}, 'sha512-x'] },
    });
    const root = repository({
      'bun.lock': workspaceLockfile,
      'packages/app/bun.lock': minimalLockfile(1),
    });
    expect(() =>
      readManifests(root, ['bun.lock', 'packages/app/bun.lock'], { layout: 'workspaces' }),
    ).toThrow('packages/app/bun.lock and bun.lock both describe packages/app/package.json');
    // The lockfile layout names manifests after the lockfiles, so they never collide.
    expect(
      Object.keys(readManifests(root, ['bun.lock', 'packages/app/bun.lock']).manifests),
    ).toEqual(['bun.lock', 'packages/app/bun.lock']);
  });

  test('names a lockfile that cannot be read', () => {
    const root = repository({});
    expect(() => readManifests(root, ['apps/missing/bun.lock'])).toThrow('apps/missing/bun.lock:');
  });

  test('names the lockfile that failed to parse', () => {
    const root = repository({ 'apps/web/bun.lock': '{ "lockfileVersion": 1 }' });
    expect(() => readManifests(root, ['apps/web/bun.lock'])).toThrow(LockfileError);
    expect(() => readManifests(root, ['apps/web/bun.lock'])).toThrow('apps/web/bun.lock:');
  });
});

describe('createSnapshot', () => {
  test('fills in the detector, the default correlator and the scan time', () => {
    const snapshot = createSnapshot({
      manifests: {},
      sha: 'a'.repeat(40),
      ref: 'refs/heads/main',
      jobId: '42',
      jobUrl: 'https://github.com/o/r/actions/runs/42',
      detectorVersion: '1.2.3',
      scanned: new Date('2026-10-27T12:00:00Z'),
    });
    expect(snapshot).toEqual({
      version: 0,
      sha: 'a'.repeat(40),
      ref: 'refs/heads/main',
      job: {
        correlator: 'bun-lock-submission',
        id: '42',
        html_url: 'https://github.com/o/r/actions/runs/42',
      },
      detector: {
        name: 'bun-lock-submission',
        version: '1.2.3',
        url: 'https://github.com/charpeni/bun-lock-submission',
      },
      scanned: '2026-10-27T12:00:00.000Z',
      manifests: {},
    });
  });

  test('stamps the current time by default, since GitHub ignores older snapshots', () => {
    const before = Date.now();
    const snapshot = createSnapshot({
      manifests: {},
      sha: 'a',
      ref: 'r',
      jobId: '1',
      detectorVersion: '0',
    });
    expect(Date.parse(snapshot.scanned)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(snapshot.scanned)).toBeLessThanOrEqual(Date.now());
  });
});

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('submitSnapshot', () => {
  const snapshot = createSnapshot({
    manifests: {},
    sha: 'a',
    ref: 'refs/heads/main',
    jobId: '1',
    detectorVersion: '0',
  });

  const failure = (status: number, body: unknown) =>
    submitSnapshot(snapshot, {
      repository: 'owner/repo',
      token: 't',
      fetch: fakeFetch(status, body).fetch,
    });

  test('posts the snapshot and returns GitHub’s result', async () => {
    const { fetch, calls } = fakeFetch(201, {
      id: 7,
      created_at: '2026-10-27T12:00:01Z',
      result: 'SUCCESS',
      message: 'Dependency results for the repo have been successfully updated.',
    });
    const result = await submitSnapshot(snapshot, {
      repository: 'owner/repo',
      token: 'secret',
      apiUrl: 'https://ghe.example.com/api/v3/',
      fetch,
    });
    expect(result).toEqual({
      id: 7,
      createdAt: '2026-10-27T12:00:01Z',
      result: 'SUCCESS',
      message: 'Dependency results for the repo have been successfully updated.',
    });
    expect(calls[0]?.url).toBe(
      'https://ghe.example.com/api/v3/repos/owner/repo/dependency-graph/snapshots',
    );
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer secret');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(snapshot);
  });

  test('explains an invalid token, a missing repository and other failures', async () => {
    await expect(failure(401, { message: 'Bad credentials' })).rejects.toThrow(
      'GitHub rejected the snapshot (HTTP 401): Bad credentials. Check that the token is valid.',
    );
    await expect(failure(404, { message: 'Not Found' })).rejects.toThrow(
      'Check that owner/repo exists, that the token can see it, and that its dependency graph is enabled.',
    );
    await expect(failure(502, '<html>Bad gateway</html>')).rejects.toThrow(
      'GitHub rejected the snapshot (HTTP 502): <html>Bad gateway</html>.',
    );
    await expect(failure(422, { message: 'Invalid request' })).rejects.toMatchObject({
      name: 'SubmissionError',
      status: 422,
    });
  });

  test('reports a network failure as a submission error', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    const submission = submitSnapshot(snapshot, { repository: 'owner/repo', token: 't', fetch });
    await expect(submission).rejects.toMatchObject({
      name: 'SubmissionError',
      status: 0,
      message:
        'Could not reach https://api.github.com/repos/owner/repo/dependency-graph/snapshots: fetch failed',
    });
  });

  test('explains a missing permission', async () => {
    const { fetch } = fakeFetch(403, { message: 'Resource not accessible by integration' });
    const submission = submitSnapshot(snapshot, { repository: 'owner/repo', token: 't', fetch });
    await expect(submission).rejects.toThrow(SubmissionError);
    await expect(submission).rejects.toThrow('contents: write');
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseLockfile } from './lockfile.ts';
import { buildManifests, toPackageUrl } from './manifests.ts';

import type { BunLock, PackageEntry } from './lockfile.ts';
import type { Manifest, ManifestOptions } from './manifests.ts';

const fixture = parseLockfile(
  readFileSync(fileURLToPath(new URL('../fixtures/handwritten/bun.lock', import.meta.url)), 'utf8'),
);

/** Flattens a manifest to `purl -> "relationship scope"` for compact assertions. */
function summarize(manifest: Manifest | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.values(manifest?.resolved ?? {}).map((dependency) => [
      dependency.package_url,
      `${dependency.relationship} ${dependency.scope}`,
    ]),
  );
}

describe('lockfile layout', () => {
  test('leaves exact pins to package.json and submits everything else', () => {
    const { manifests, stats } = buildManifests('bun.lock', fixture);
    expect(Object.keys(manifests)).toEqual(['bun.lock']);
    expect(summarize(manifests['bun.lock'])).toEqual({
      // Kept: a range, an npm: alias (under its real name), a catalog: copy nested under
      // its workspace, and a private package declared with a range.
      'pkg:npm/chalk@5.3.0': 'direct runtime',
      'pkg:npm/string-width@4.2.3': 'direct runtime',
      'pkg:npm/ms@3.0.0': 'direct runtime',
      'pkg:npm/%40private/sdk@1.0.0': 'direct runtime',
      // Transitive, including the children of github: and file: packages, and the
      // devDependencies Bun installs for a file: package.
      'pkg:npm/emoji-regex@8.0.0': 'indirect runtime',
      'pkg:npm/uuid@8.3.2': 'indirect runtime',
      'pkg:npm/ms@2.1.3': 'indirect runtime',
      'pkg:npm/typescript-lite@1.0.0': 'indirect runtime',
      // Only reachable through devDependencies.
      'pkg:npm/%40scope/mocker@2.0.0': 'indirect development',
      'pkg:npm/ms@1.0.0': 'indirect development',
    });
    // left-pad, uuid@14.0.0, test-runner and debug are exact pins equal to the locked version.
    expect(stats).toEqual({
      packages: 10,
      direct: 4,
      indirect: 6,
      skippedExactPins: 4,
      excluded: 0,
    });
  });

  test('labels each version on its own when exact pins are included', () => {
    const { manifests } = buildManifests('bun.lock', fixture, { includeExactPins: true });
    const summary = summarize(manifests['bun.lock']);
    expect(summary['pkg:npm/uuid@14.0.0']).toBe('direct runtime');
    expect(summary['pkg:npm/uuid@8.3.2']).toBe('indirect runtime');
    expect(summary['pkg:npm/left-pad@1.3.0']).toBe('direct runtime');
    expect(summary['pkg:npm/test-runner@2.0.0']).toBe('direct development');
    // Declared as a devDependency and otherwise only reached through test-runner.
    expect(summary['pkg:npm/debug@4.3.4']).toBe('direct development');
  });

  test('records each package’s resolved children by package URL', () => {
    const { manifests } = buildManifests('bun.lock', fixture, { includeExactPins: true });
    const resolved = manifests['bun.lock']?.resolved ?? {};
    expect(resolved['pkg:npm/%40scope/mocker@2.0.0']?.dependencies).toEqual(['pkg:npm/ms@1.0.0']);
    expect(resolved['pkg:npm/test-runner@2.0.0']?.dependencies).toEqual([
      'pkg:npm/%40scope/mocker@2.0.0',
      'pkg:npm/debug@4.3.4',
    ]);
    expect(resolved['pkg:npm/string-width@4.2.3']?.dependencies).toEqual([
      'pkg:npm/emoji-regex@8.0.0',
    ]);
  });

  test('excludes packages by name pattern but keeps walking their dependencies', () => {
    const { manifests, stats } = buildManifests('bun.lock', fixture, { exclude: ['@private/*'] });
    const summary = summarize(manifests['bun.lock']);
    expect(summary['pkg:npm/%40private/sdk@1.0.0']).toBeUndefined();
    expect(summary['pkg:npm/ms@2.1.3']).toBe('indirect runtime');
    expect(stats.excluded).toBe(1);
  });

  test('names the manifest after the lockfile path', () => {
    const { manifests } = buildManifests('apps/web/bun.lock', fixture);
    expect(Object.keys(manifests)).toEqual(['apps/web/bun.lock']);
    expect(manifests['apps/web/bun.lock']?.file).toEqual({ source_location: 'apps/web/bun.lock' });
  });
});

describe('workspaces layout', () => {
  test('puts direct dependencies in their package.json and transitive ones in the root', () => {
    const { manifests, stats } = buildManifests('bun.lock', fixture, { layout: 'workspaces' });
    expect(Object.keys(manifests).toSorted()).toEqual([
      'package.json',
      'packages/app/package.json',
      'packages/lib/package.json',
    ]);
    expect(summarize(manifests['packages/app/package.json'])).toEqual({
      'pkg:npm/left-pad@1.3.0': 'direct runtime',
      'pkg:npm/ms@3.0.0': 'direct runtime',
      'pkg:npm/debug@4.3.4': 'direct development',
    });
    expect(summarize(manifests['packages/lib/package.json'])).toEqual({
      'pkg:npm/%40private/sdk@1.0.0': 'direct runtime',
      'pkg:npm/uuid@14.0.0': 'direct runtime',
    });
    // The root's own declarations, then every transitive package once. debug and uuid@14 are
    // direct in other workspaces, so they are not repeated here.
    expect(summarize(manifests['package.json'])).toEqual({
      'pkg:npm/chalk@5.3.0': 'direct runtime',
      'pkg:npm/left-pad@1.3.0': 'direct runtime',
      'pkg:npm/string-width@4.2.3': 'direct runtime',
      'pkg:npm/test-runner@2.0.0': 'direct development',
      'pkg:npm/emoji-regex@8.0.0': 'indirect runtime',
      'pkg:npm/uuid@8.3.2': 'indirect runtime',
      'pkg:npm/ms@2.1.3': 'indirect runtime',
      'pkg:npm/typescript-lite@1.0.0': 'indirect runtime',
      'pkg:npm/%40scope/mocker@2.0.0': 'indirect development',
      'pkg:npm/ms@1.0.0': 'indirect development',
    });
    expect(stats).toEqual({
      packages: 14,
      direct: 8,
      indirect: 6,
      skippedExactPins: 0,
      excluded: 0,
    });
  });

  test('nests manifest paths under the lockfile directory', () => {
    const { manifests } = buildManifests('apps/web/bun.lock', fixture, { layout: 'workspaces' });
    expect(Object.keys(manifests).toSorted()).toEqual([
      'apps/web/package.json',
      'apps/web/packages/app/package.json',
      'apps/web/packages/lib/package.json',
    ]);
  });
});

describe('toPackageUrl', () => {
  test('percent-encodes the scope and reserved version characters', () => {
    expect(toPackageUrl('ms', '2.1.3')).toBe('pkg:npm/ms@2.1.3');
    expect(toPackageUrl('@scope/name', '1.0.0')).toBe('pkg:npm/%40scope/name@1.0.0');
    expect(toPackageUrl('pkg', '1.0.0+build.1')).toBe('pkg:npm/pkg@1.0.0%2Bbuild.1');
  });
});

/** Builds a lockfile in memory, so each test shows only the shape it is about. */
function lockfile(workspaces: BunLock['workspaces'], packages: BunLock['packages']): BunLock {
  return { lockfileVersion: 1, workspaces, packages };
}

function npm(resolution: string, info: Record<string, unknown> = {}): PackageEntry {
  return [resolution, '', info, 'sha512-x'];
}

function lockfileSummary(lock: BunLock, options: ManifestOptions = {}) {
  return summarize(buildManifests('bun.lock', lock, options).manifests['bun.lock']);
}

describe('lockfile shapes', () => {
  test('merges one version installed under several keys, whatever the key order', () => {
    // A direct npm: alias and a transitive copy of the same version, as in many real lockfiles.
    const entries: [string, PackageEntry][] = [
      [
        'string-width-cjs',
        npm('string-width@4.2.3', { dependencies: { 'emoji-regex': '^8.0.0' } }),
      ],
      ['cli-ui', npm('cli-ui@1.0.0', { dependencies: { 'string-width': '^4.0.0' } })],
      ['string-width', npm('string-width@4.2.3', { dependencies: { 'strip-ansi': '^6.0.0' } })],
      ['emoji-regex', npm('emoji-regex@8.0.0')],
      ['strip-ansi', npm('strip-ansi@6.0.1')],
    ];
    const workspaces = {
      '': {
        devDependencies: { 'cli-ui': '^1.0.0' },
        dependencies: { 'string-width-cjs': 'npm:string-width@4.2.3' },
      },
    };
    const forward = buildManifests('bun.lock', lockfile(workspaces, Object.fromEntries(entries)));
    const backward = buildManifests(
      'bun.lock',
      lockfile(workspaces, Object.fromEntries(entries.toReversed())),
    );
    const merged = forward.manifests['bun.lock']?.resolved['pkg:npm/string-width@4.2.3'];
    expect(merged).toEqual({
      package_url: 'pkg:npm/string-width@4.2.3',
      relationship: 'direct',
      scope: 'runtime',
      dependencies: ['pkg:npm/emoji-regex@8.0.0', 'pkg:npm/strip-ansi@6.0.1'],
    });
    expect(JSON.stringify(backward.manifests)).toBe(JSON.stringify(forward.manifests));
    expect(forward.stats.packages).toBe(4);
  });

  test('keeps runtime when one copy of a version is runtime and another development', () => {
    const lock = lockfile(
      { '': { dependencies: { server: '^1.0.0' }, devDependencies: { tool: '^1.0.0' } } },
      {
        server: npm('server@1.0.0', { dependencies: { ms: '^2.0.0' } }),
        'server/ms': npm('ms@2.0.0'),
        tool: npm('tool@1.0.0', { dependencies: { ms: '^2.0.0' } }),
        'tool/ms': npm('ms@2.0.0'),
      },
    );
    expect(lockfileSummary(lock)['pkg:npm/ms@2.0.0']).toBe('indirect runtime');
  });

  test('stops at dependency cycles', () => {
    const lock = lockfile(
      { '': { dependencies: { a: '^1.0.0' } } },
      {
        a: npm('a@1.0.0', { dependencies: { b: '^1.0.0' } }),
        b: npm('b@1.0.0', { dependencies: { a: '^1.0.0' } }),
      },
    );
    const { manifests } = buildManifests('bun.lock', lock);
    expect(summarize(manifests['bun.lock'])).toEqual({
      'pkg:npm/a@1.0.0': 'direct runtime',
      'pkg:npm/b@1.0.0': 'indirect runtime',
    });
    expect(manifests['bun.lock']?.resolved['pkg:npm/b@1.0.0']?.dependencies).toEqual([
      'pkg:npm/a@1.0.0',
    ]);
  });

  test('follows installed peer dependencies and ignores optional peers that are not installed', () => {
    const lock = lockfile(
      { '': { dependencies: { 'react-dom': '^19.0.0' } } },
      {
        'react-dom': npm('react-dom@19.0.0', {
          peerDependencies: { react: '^19.0.0', 'react-native': '*' },
          optionalPeers: ['react-native'],
        }),
        react: npm('react@19.0.0'),
      },
    );
    const { manifests } = buildManifests('bun.lock', lock);
    expect(summarize(manifests['bun.lock'])).toEqual({
      'pkg:npm/react-dom@19.0.0': 'direct runtime',
      'pkg:npm/react@19.0.0': 'indirect runtime',
    });
    expect(manifests['bun.lock']?.resolved['pkg:npm/react-dom@19.0.0']?.dependencies).toEqual([
      'pkg:npm/react@19.0.0',
    ]);
  });

  test('treats workspace optional and peer dependencies as runtime', () => {
    const lock = lockfile(
      {
        '': {
          optionalDependencies: { fsevents: '^2.0.0' },
          peerDependencies: { typescript: '^5.0.0' },
        },
      },
      { fsevents: npm('fsevents@2.3.3'), typescript: npm('typescript@5.9.3') },
    );
    expect(lockfileSummary(lock)).toEqual({
      'pkg:npm/fsevents@2.3.3': 'direct runtime',
      'pkg:npm/typescript@5.9.3': 'direct runtime',
    });
  });

  test('finds the copies a scoped workspace nests under its own name', () => {
    const lock = lockfile(
      {
        '': { dependencies: { debug: '^4.0.0' } },
        'apps/web': { name: '@acme/web', dependencies: { ms: '^3.0.0' } },
      },
      {
        debug: npm('debug@4.3.4', { dependencies: { ms: '^2.1.0' } }),
        ms: npm('ms@2.1.3'),
        '@acme/web': ['@acme/web@workspace:apps/web'],
        '@acme/web/ms': npm('ms@3.0.0'),
      },
    );
    expect(lockfileSummary(lock)).toEqual({
      'pkg:npm/debug@4.3.4': 'direct runtime',
      'pkg:npm/ms@3.0.0': 'direct runtime',
      'pkg:npm/ms@2.1.3': 'indirect runtime',
    });
  });

  test('walks tarball and link: packages without submitting them', () => {
    const lock = lockfile(
      {
        '': {
          dependencies: {
            'tar-dep': 'https://example.com/tar-dep-1.0.0.tgz',
            linked: 'link:linked',
          },
        },
      },
      {
        'tar-dep': [
          'tar-dep@https://example.com/tar-dep-1.0.0.tgz',
          { dependencies: { ms: '^2.0.0' } },
        ],
        linked: ['linked@link:linked', { dependencies: { debug: '^4.0.0' } }],
        ms: npm('ms@2.1.3'),
        debug: npm('debug@4.3.4'),
      },
    );
    expect(lockfileSummary(lock)).toEqual({
      'pkg:npm/ms@2.1.3': 'indirect runtime',
      'pkg:npm/debug@4.3.4': 'indirect runtime',
    });
  });
});

/** A lockfile where the root, and optionally a workspace, declare left-pad. */
const pinned = (specifiers: Record<string, string>, version = '1.3.0') =>
  lockfile(
    {
      '': { dependencies: { 'left-pad': specifiers.root ?? '' } },
      ...(specifiers.app
        ? { 'packages/app': { name: 'app', dependencies: { 'left-pad': specifiers.app } } }
        : {}),
    },
    { 'left-pad': npm(`left-pad@${version}`) },
  );

describe('exact pins', () => {
  test('skips a version every declaration pins exactly, prereleases included', () => {
    expect(lockfileSummary(pinned({ root: '1.3.0', app: '1.3.0' }))).toEqual({});
    expect(lockfileSummary(pinned({ root: '2.0.0-beta.1' }, '2.0.0-beta.1'))).toEqual({});
  });

  test('keeps a version whose pin differs from the lockfile, such as after an override', () => {
    expect(lockfileSummary(pinned({ root: '1.3.0' }, '1.3.1'))).toEqual({
      'pkg:npm/left-pad@1.3.1': 'direct runtime',
    });
  });

  test('keeps a version that one workspace pins and another declares with a range', () => {
    expect(lockfileSummary(pinned({ root: '1.3.0', app: '^1.3.0' }))).toEqual({
      'pkg:npm/left-pad@1.3.0': 'direct runtime',
    });
  });

  test('keeps a pin that an override points at another package', () => {
    // `"overrides": { "lodash": "npm:lodash-es@4.17.21" }` installs lodash-es for a lodash pin,
    // and GitHub's package.json analysis would check lodash instead.
    const lock = lockfile(
      { '': { dependencies: { lodash: '4.17.21' } } },
      { lodash: npm('lodash-es@4.17.21') },
    );
    expect(lockfileSummary(lock)).toEqual({ 'pkg:npm/lodash-es@4.17.21': 'direct runtime' });
  });

  test('keeps specifiers GitHub does not read as that exact version', () => {
    for (const specifier of ['^1.3.0', '~1.3.0', '=1.3.0', 'v1.3.0', '>=1.3.0', 'latest']) {
      expect(lockfileSummary(pinned({ root: specifier }))).toEqual({
        'pkg:npm/left-pad@1.3.0': 'direct runtime',
      });
    }
  });
});

describe('exclude', () => {
  const lock = lockfile(
    {
      '': {
        dependencies: {
          'lodash.merge': '^4.0.0',
          lodashxmerge: '^1.0.0',
          '@types/node': '^24.0.0',
          '@typesx/node': '^1.0.0',
        },
      },
    },
    {
      'lodash.merge': npm('lodash.merge@4.6.2'),
      lodashxmerge: npm('lodashxmerge@1.0.0'),
      '@types/node': npm('@types/node@24.0.0'),
      '@typesx/node': npm('@typesx/node@1.0.0'),
    },
  );

  test('matches whole names, with dots taken literally and * as a wildcard', () => {
    const { manifests, stats } = buildManifests('bun.lock', lock, {
      exclude: ['lodash.merge', '@types/*'],
    });
    expect(Object.keys(manifests['bun.lock']?.resolved ?? {}).toSorted()).toEqual([
      'pkg:npm/%40typesx/node@1.0.0',
      'pkg:npm/lodashxmerge@1.0.0',
    ]);
    expect(stats.excluded).toBe(2);
  });
});

describe('workspaces layout details', () => {
  test('gives a workspace without dependencies an empty manifest, replacing GitHub’s own', () => {
    const lock = lockfile(
      { '': { dependencies: { ms: '^2.0.0' } }, 'packages/empty': { name: 'empty' } },
      { ms: npm('ms@2.1.3'), empty: ['empty@workspace:packages/empty'] },
    );
    const { manifests } = buildManifests('bun.lock', lock, { layout: 'workspaces' });
    expect(manifests['packages/empty/package.json']).toEqual({
      name: 'packages/empty/package.json',
      file: { source_location: 'packages/empty/package.json' },
      resolved: {},
    });
  });

  test('labels each declaration with its own workspace’s scope', () => {
    const lock = lockfile(
      {
        '': { devDependencies: { typescript: '5.9.3' } },
        'packages/lib': { name: 'lib', dependencies: { typescript: '5.9.3' } },
      },
      { typescript: npm('typescript@5.9.3'), lib: ['lib@workspace:packages/lib'] },
    );
    const { manifests } = buildManifests('bun.lock', lock, { layout: 'workspaces' });
    expect(summarize(manifests['package.json'])).toEqual({
      'pkg:npm/typescript@5.9.3': 'direct development',
    });
    expect(summarize(manifests['packages/lib/package.json'])).toEqual({
      'pkg:npm/typescript@5.9.3': 'direct runtime',
    });
    expect(lockfileSummary(lock, { includeExactPins: true })).toEqual({
      'pkg:npm/typescript@5.9.3': 'direct runtime',
    });
  });
});

describe('one version declared and reached several ways', () => {
  test('upgrades a transitive runtime copy to direct when the declared copy comes later', () => {
    // The runtime walk reaches string-width through server before the dev alias declares it.
    const lock = lockfile(
      {
        '': {
          dependencies: { server: '^1.0.0' },
          devDependencies: { 'string-width-cjs': 'npm:string-width@4.2.3' },
        },
      },
      {
        server: npm('server@1.0.0', { dependencies: { 'string-width': '^4.0.0' } }),
        'string-width': npm('string-width@4.2.3'),
        'string-width-cjs': npm('string-width@4.2.3'),
      },
    );
    expect(lockfileSummary(lock)['pkg:npm/string-width@4.2.3']).toBe('direct runtime');
  });

  test('keeps runtime for a package a workspace lists in devDependencies and peerDependencies', () => {
    const lock = lockfile(
      {
        '': {},
        'packages/ui': {
          name: 'ui',
          devDependencies: { react: '19.0.0' },
          peerDependencies: { react: '^19.0.0' },
        },
      },
      { ui: ['ui@workspace:packages/ui'], react: npm('react@19.0.0') },
    );
    const { manifests } = buildManifests('bun.lock', lock, { layout: 'workspaces' });
    expect(summarize(manifests['packages/ui/package.json'])).toEqual({
      'pkg:npm/react@19.0.0': 'direct runtime',
    });
    // The peer declaration is a range, so the version is still submitted in the lockfile layout.
    expect(lockfileSummary(lock)).toEqual({ 'pkg:npm/react@19.0.0': 'direct runtime' });
  });
});

describe('review findings', () => {
  test('does not let an installed optional peer make a dev-only package runtime', () => {
    const lock = lockfile(
      { '': { dependencies: { next: '^15.0.0' }, devDependencies: { sass: '^1.0.0' } } },
      {
        next: npm('next@15.0.0', { peerDependencies: { sass: '^1.3.0' }, optionalPeers: ['sass'] }),
        sass: npm('sass@1.80.0', { dependencies: { immutable: '^4.0.0' } }),
        immutable: npm('immutable@4.3.7'),
      },
    );
    const { manifests } = buildManifests('bun.lock', lock);
    expect(summarize(manifests['bun.lock'])).toEqual({
      'pkg:npm/next@15.0.0': 'direct runtime',
      'pkg:npm/sass@1.80.0': 'direct development',
      'pkg:npm/immutable@4.3.7': 'indirect development',
    });
    expect(manifests['bun.lock']?.resolved['pkg:npm/next@15.0.0']?.dependencies).toEqual([]);
  });

  test('still submits exact pins in peerDependencies, which GitHub does not read', () => {
    const lock = lockfile(
      {
        '': { peerDependencies: { react: '19.0.0' }, optionalDependencies: { fsevents: '2.3.3' } },
      },
      { react: npm('react@19.0.0'), fsevents: npm('fsevents@2.3.3') },
    );
    const { manifests, stats } = buildManifests('bun.lock', lock);
    expect(summarize(manifests['bun.lock'])).toEqual({ 'pkg:npm/react@19.0.0': 'direct runtime' });
    expect(stats.skippedExactPins).toBe(1);
  });

  test('excludes only whole names', () => {
    const lock = lockfile(
      {
        '': {
          dependencies: {
            sdk: '^1.0.0',
            'sdk-extra': '^1.0.0',
            '@acme/sdk': '^1.0.0',
            '@aws-sdk/client-s3': '^3.0.0',
          },
        },
      },
      {
        sdk: npm('sdk@1.0.0'),
        'sdk-extra': npm('sdk-extra@1.0.0'),
        '@acme/sdk': npm('@acme/sdk@1.0.0'),
        '@aws-sdk/client-s3': npm('@aws-sdk/client-s3@3.0.0'),
      },
    );
    const { manifests, stats } = buildManifests('bun.lock', lock, { exclude: ['sdk'] });
    expect(Object.keys(manifests['bun.lock']?.resolved ?? {}).toSorted()).toEqual([
      'pkg:npm/%40acme/sdk@1.0.0',
      'pkg:npm/%40aws-sdk/client-s3@3.0.0',
      'pkg:npm/sdk-extra@1.0.0',
    ]);
    expect(stats.excluded).toBe(1);
  });

  test('keeps a workspace’s own dependencies runtime, even when it is only a devDependency', () => {
    // Every workspace is a package of its own, the way npm workspaces treat them.
    const lock = lockfile(
      {
        '': { devDependencies: { 'test-utils': 'workspace:*' } },
        'packages/test-utils': { name: 'test-utils', dependencies: { jest: '^29.0.0' } },
      },
      { 'test-utils': ['test-utils@workspace:packages/test-utils'], jest: npm('jest@29.7.0') },
    );
    expect(lockfileSummary(lock)).toEqual({ 'pkg:npm/jest@29.7.0': 'direct runtime' });
  });
});

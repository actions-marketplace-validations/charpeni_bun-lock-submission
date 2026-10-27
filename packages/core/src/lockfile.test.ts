import { describe, expect, test } from 'bun:test';

import {
  isRegistryVersion,
  LockfileError,
  packageInfo,
  parseJsonc,
  parseLockfile,
  resolveKey,
  splitKey,
  splitResolution,
} from './lockfile.ts';

describe('parseJsonc', () => {
  test('drops trailing commas in objects and arrays', () => {
    expect(parseJsonc('{ "a": [1, 2,], "b": { "c": true, }, }')).toEqual({
      a: [1, 2],
      b: { c: true },
    });
  });

  test('leaves commas, brackets and slashes inside strings alone', () => {
    expect(
      parseJsonc(String.raw`{ "a": ",}", "b": ",]", "c": "x\",}", "d": "//not a comment", }`),
    ).toEqual({
      a: ',}',
      b: ',]',
      c: 'x",}',
      d: '//not a comment',
    });
  });

  test('ends a string at its closing quote, even after an escaped backslash', () => {
    expect(parseJsonc(String.raw`{ "a": "x\\", "b": "\"", }`)).toEqual({ a: 'x\\', b: '"' });
  });

  test('skips line and block comments, including between a trailing comma and its bracket', () => {
    expect(parseJsonc('{\n  // note\n  "a": 1, /* last */\n}')).toEqual({ a: 1 });
  });
});

describe('parseLockfile', () => {
  test('rejects input that is not a lockfile', () => {
    expect(() => parseLockfile('{ "packages": {} }')).toThrow(LockfileError);
    expect(() => parseLockfile('not json')).toThrow('Not valid JSON');
    expect(() =>
      parseLockfile('{ "lockfileVersion": 1, "workspaces": {}, "packages": { "a": "a@1.0.0" } }'),
    ).toThrow('Package "a"');
    expect(() =>
      parseLockfile('{ "lockfileVersion": "1", "workspaces": {}, "packages": {} }'),
    ).toThrow('numeric `lockfileVersion`');
  });
});

describe('splitResolution', () => {
  test('splits at the first @ after the package name', () => {
    expect(splitResolution('ms@2.1.3')).toEqual({ name: 'ms', version: '2.1.3' });
    expect(splitResolution('@scope/name@1.0.0-beta.1')).toEqual({
      name: '@scope/name',
      version: '1.0.0-beta.1',
    });
    expect(() => splitResolution('no-version')).toThrow(LockfileError);
    expect(splitResolution('dep@git+ssh://git@github.com/owner/dep.git#abc')).toEqual({
      name: 'dep',
      version: 'git+ssh://git@github.com/owner/dep.git#abc',
    });
  });
});

describe('isRegistryVersion', () => {
  test('accepts semver and rejects other resolutions', () => {
    expect(isRegistryVersion('1.2.3')).toBe(true);
    expect(isRegistryVersion('1.2.3-rc.1+build.5')).toBe(true);
    for (const version of [
      'workspace:packages/a',
      'file:a',
      'link:a',
      'github:o/r#abc',
      'https://example.com/a.tgz',
      'root:',
    ]) {
      expect(isRegistryVersion(version)).toBe(false);
    }
  });
});

describe('packageInfo', () => {
  test('finds the metadata object whatever its index', () => {
    expect(packageInfo(['a@1.0.0', '', { dependencies: { b: '1' } }, 'sha512-x'])).toEqual({
      dependencies: { b: '1' },
    });
    expect(packageInfo(['a@file:a', { dependencies: { b: '1' } }])).toEqual({
      dependencies: { b: '1' },
    });
    expect(packageInfo(['a@workspace:a'])).toEqual({});
  });
});

describe('splitKey and resolveKey', () => {
  test('treats a scoped name as one segment', () => {
    expect(splitKey('a/@scope/b/c')).toEqual(['a', '@scope/b', 'c']);
  });

  test('walks up from the deepest nesting to the hoisted copy', () => {
    const packages = {
      a: ['a@1.0.0'],
      'a/@scope/b': ['@scope/b@1.0.0'],
      'a/c': ['c@2.0.0'],
      c: ['c@1.0.0'],
    } satisfies Record<string, [string]>;
    expect(resolveKey(packages, 'a/@scope/b', 'c')).toBe('a/c');
    expect(resolveKey(packages, 'a', '@scope/b')).toBe('a/@scope/b');
    expect(resolveKey(packages, '', 'c')).toBe('c');
    expect(resolveKey(packages, 'a', 'missing')).toBeUndefined();
  });
});

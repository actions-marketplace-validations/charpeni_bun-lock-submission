import { describe, expect, test } from 'bun:test';
/**
 * Checks the lockfile reader against real projects. Each fixture under `fixtures/projects`
 * holds a `bun.lock` written by a real Bun release, and an `installed.json` that records
 * what that release actually installed, read from `node_modules` without looking at the
 * lockfile. Regenerate them with `bun packages/core/scripts/generate-fixtures.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLockfile, splitResolution } from './lockfile.ts';
import { buildManifests, toPackageUrl } from './manifests.ts';

import type { InstalledProject } from '../fixtures/installed.ts';
import type { BunLock } from './lockfile.ts';
import type { Manifest } from './manifests.ts';

const PROJECTS = fileURLToPath(new URL('../fixtures/projects', import.meta.url));

const fixtures = readdirSync(PROJECTS)
  .toSorted()
  .map((name) => ({
    name,
    lock: parseLockfile(readFileSync(join(PROJECTS, name, 'bun.lock'), 'utf8')),
    installed: JSON.parse(
      readFileSync(join(PROJECTS, name, 'installed.json'), 'utf8'),
    ) as InstalledProject,
  }));

const purlOf = (id: string) => {
  const { name, version } = splitResolution(id);
  return toPackageUrl(name, version);
};

const nameOfPurl = (purl: string) =>
  decodeURIComponent(purl.slice('pkg:npm/'.length, purl.lastIndexOf('@')));

function resolvedOf(lock: BunLock, options = {}): Manifest['resolved'] {
  return buildManifests('bun.lock', lock, { includeExactPins: true, ...options }).manifests[
    'bun.lock'
  ]!.resolved;
}

describe.each(fixtures)('$name', ({ lock, installed }) => {
  test('was written in the lockfile version its Bun release uses', () => {
    expect(lock.lockfileVersion).toBe(installed.lockfileVersion);
  });

  test('submits every installed package with Bun’s relationship and scope', () => {
    const resolved = resolvedOf(lock);
    const expected = Object.fromEntries(
      Object.entries(installed.packages).map(([id, { direct, scope }]) => [
        purlOf(id),
        `${direct ? 'direct' : 'indirect'} ${scope}`,
      ]),
    );
    const actual = Object.fromEntries(
      Object.values(resolved)
        // Optional packages for other platforms are locked but were not installed here.
        .filter(
          (dependency) => !installed.skippedOptional.includes(nameOfPurl(dependency.package_url)),
        )
        .map((dependency) => [
          dependency.package_url,
          `${dependency.relationship} ${dependency.scope}`,
        ]),
    );
    expect(actual).toEqual(expected);
  });

  test('records the dependencies each installed package resolved to', () => {
    const resolved = resolvedOf(lock);
    for (const [id, { dependencies }] of Object.entries(installed.packages)) {
      const submitted = resolved[purlOf(id)]?.dependencies ?? [];
      expect({
        id,
        dependencies: submitted.filter(
          (purl) => !installed.skippedOptional.includes(nameOfPurl(purl)),
        ),
      }).toEqual({
        id,
        dependencies: dependencies.map(purlOf).toSorted(),
      });
    }
  });

  test('leaves out exactly the direct versions every package.json pins where GitHub reads it', () => {
    const declarations = Object.values(installed.workspaces).flatMap((declared) =>
      Object.values(declared),
    );
    const pinnedEverywhere = new Set(
      declarations
        .filter(({ id }) =>
          declarations
            .filter((other) => other.id === id)
            // GitHub's own package.json analysis skips peerDependencies.
            .every(
              ({ field, specifier }) =>
                field !== 'peerDependencies' && specifier === splitResolution(id).version,
            ),
        )
        .map(({ id }) => purlOf(id)),
    );
    const all = Object.keys(resolvedOf(lock));
    const kept = Object.keys(resolvedOf(lock, { includeExactPins: false }));
    expect(all.filter((purl) => !kept.includes(purl)).toSorted()).toEqual(
      [...pinnedEverywhere].toSorted(),
    );
  });

  test('puts each workspace’s declarations in its package.json in the workspaces layout', () => {
    const { manifests } = buildManifests('bun.lock', lock, { layout: 'workspaces' });
    for (const [path, declared] of Object.entries(installed.workspaces)) {
      const manifest = manifests[path === '' ? 'package.json' : `${path}/package.json`];
      const direct = Object.values(manifest?.resolved ?? {})
        .filter((dependency) => dependency.relationship === 'direct')
        .map((dependency) => `${dependency.package_url} ${dependency.scope}`);
      expect({ path, direct: direct.toSorted() }).toEqual({
        path,
        direct: Object.values(declared)
          .map(({ id, scope }) => `${purlOf(id)} ${scope}`)
          .toSorted(),
      });
    }
    const union = new Set(
      Object.values(manifests).flatMap((manifest) => Object.keys(manifest.resolved)),
    );
    expect([...union].toSorted()).toEqual(Object.keys(resolvedOf(lock)).toSorted());
  });
});

test('the fixtures cover every lockfile version and the setups that matter', () => {
  expect(new Set(fixtures.map(({ lock }) => lock.lockfileVersion))).toEqual(new Set([0, 1, 2, 3]));
  const installed = fixtures.map((fixture) => fixture.installed);
  // A single package and a monorepo with several workspaces.
  expect(installed.some((project) => Object.keys(project.workspaces).length === 1)).toBe(true);
  expect(installed.some((project) => Object.keys(project.workspaces).length > 2)).toBe(true);
  // One package name installed at several versions.
  expect(
    installed.some((project) => {
      const names = Object.keys(project.packages).map((id) => splitResolution(id).name);
      return new Set(names).size < names.length;
    }),
  ).toBe(true);
  // Optional packages skipped on this platform, and dependency specifiers of every kind.
  expect(installed.some((project) => project.skippedOptional.length > 0)).toBe(true);
  const specifiers = installed.flatMap((project) =>
    Object.values(project.workspaces).flatMap((declared) =>
      Object.values(declared).map(({ specifier }) => specifier),
    ),
  );
  for (const kind of [/^\d/, /^\^/, /^npm:/, /^catalog:$/, /^catalog:\w/]) {
    expect(specifiers.some((specifier) => kind.test(specifier))).toBe(true);
  }
  // Declarations in every field, including an exact pin in peerDependencies.
  const declarations = installed.flatMap((project) =>
    Object.values(project.workspaces).flatMap((declared) => Object.values(declared)),
  );
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    expect(declarations.some((declaration) => declaration.field === field)).toBe(true);
  }
  expect(
    declarations.some(
      ({ field, id, specifier }) =>
        field === 'peerDependencies' && specifier === splitResolution(id).version,
    ),
  ).toBe(true);
});

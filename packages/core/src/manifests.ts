import { posix } from 'node:path';

import { analyzeLockfile } from './graph.ts';
import { isRegistryVersion, splitResolution } from './lockfile.ts';

import type { Declaration, Scope } from './graph.ts';
import type { BunLock } from './lockfile.ts';

/**
 * How dependencies are grouped into manifests:
 * - `lockfile`: one manifest per `bun.lock`, which is where GitHub reports alerts.
 * - `workspaces`: one manifest per workspace `package.json`. Submitted manifests replace
 *   GitHub's own static `package.json` results at the same path, so the root
 *   `package.json` also carries every transitive package.
 */
export type Layout = 'lockfile' | 'workspaces';

export type ManifestOptions = {
  layout?: Layout;
  /**
   * In the `lockfile` layout, also submit direct dependencies that every declaring
   * `package.json` pins to exactly the locked version. GitHub's static analysis of
   * `package.json` already raises alerts for those, so including them duplicates alerts.
   */
  includeExactPins?: boolean;
  /** Package names to leave out, such as private packages. `*` matches any characters. */
  exclude?: readonly string[];
};

/** A resolved package in the dependency submission API's format. */
export type SubmittedDependency = {
  package_url: string;
  relationship: 'direct' | 'indirect';
  scope: Scope;
  dependencies: string[];
};

export type Manifest = {
  name: string;
  file: { source_location: string };
  resolved: Record<string, SubmittedDependency>;
};

export type ManifestStats = {
  /** Distinct `name@version` packages submitted across this lockfile's manifests. */
  packages: number;
  direct: number;
  indirect: number;
  /** Direct dependencies left to GitHub's static `package.json` analysis. */
  skippedExactPins: number;
  /** Packages matched by an `exclude` pattern. */
  excluded: number;
};

/**
 * Builds the manifests for one lockfile. `lockfilePath` is the lockfile's path relative
 * to the repository root, with forward slashes; manifest names derive from it.
 */
export function buildManifests(
  lockfilePath: string,
  lock: BunLock,
  options: ManifestOptions = {},
): { manifests: Record<string, Manifest>; stats: ManifestStats } {
  const { layout = 'lockfile', includeExactPins = false, exclude = [] } = options;
  const { declarations, scopes, dependenciesOf } = analyzeLockfile(lock);
  const isExcluded = compilePatterns(exclude);

  const resolutionOf = (key: string) => {
    const entry = lock.packages[key];
    if (!entry) {
      return undefined;
    }
    const { name, version } = splitResolution(entry[0]);
    // Workspace, `file:`, `link:`, git and tarball packages have no npm package URL.
    return isRegistryVersion(version) && !isExcluded(name) ? { name, version } : undefined;
  };

  const excludedNames = new Set<string>();
  for (const key of scopes.keys()) {
    const entry = lock.packages[key];
    if (entry) {
      const { name, version } = splitResolution(entry[0]);
      if (isRegistryVersion(version) && isExcluded(name)) {
        excludedNames.add(`${name}@${version}`);
      }
    }
  }

  const directKeys = new Set(declarations.flatMap((declaration) => declaration.key ?? []));
  const skipped =
    layout === 'lockfile' && !includeExactPins
      ? exactPinsCoveredByPackageJson(declarations, resolutionOf)
      : new Set<string>();

  const addPackage = (
    resolved: Record<string, SubmittedDependency>,
    key: string,
    relationship: SubmittedDependency['relationship'],
    scope: Scope,
  ) => {
    const resolution = resolutionOf(key);
    if (!resolution || skipped.has(`${resolution.name}@${resolution.version}`)) {
      return;
    }
    const packageUrl = toPackageUrl(resolution.name, resolution.version);
    const children = dependenciesOf(key).flatMap((child) => {
      const childResolution = resolutionOf(child);
      return childResolution ? [toPackageUrl(childResolution.name, childResolution.version)] : [];
    });
    const existing = resolved[packageUrl];
    if (existing) {
      // One version can sit under several lockfile keys; keep the strongest labels.
      if (relationship === 'direct') {
        existing.relationship = 'direct';
      }
      if (scope === 'runtime') {
        existing.scope = 'runtime';
      }
      existing.dependencies = [...new Set([...existing.dependencies, ...children])].toSorted();
      return;
    }
    resolved[packageUrl] = {
      package_url: packageUrl,
      relationship,
      scope,
      dependencies: [...new Set(children)].toSorted(),
    };
  };

  const manifests: Record<string, Manifest> = {};
  const manifestAt = (path: string): Manifest =>
    (manifests[path] ??= { name: path, file: { source_location: path }, resolved: {} });

  if (layout === 'lockfile') {
    const manifest = manifestAt(lockfilePath);
    for (const [key, scope] of scopes) {
      addPackage(manifest.resolved, key, directKeys.has(key) ? 'direct' : 'indirect', scope);
    }
  } else {
    const directory = posix.dirname(lockfilePath);
    const rootManifest = manifestAt(posix.join(directory, 'package.json'));
    for (const workspace of Object.keys(lock.workspaces)) {
      manifestAt(posix.join(directory, workspace, 'package.json'));
    }
    for (const declaration of declarations) {
      if (declaration.key) {
        const manifest = manifestAt(posix.join(directory, declaration.workspace, 'package.json'));
        const scope = declaration.field === 'devDependencies' ? 'development' : 'runtime';
        addPackage(manifest.resolved, declaration.key, 'direct', scope);
      }
    }
    // The root manifest carries each transitive package once, not once per workspace.
    for (const [key, scope] of scopes) {
      if (!directKeys.has(key)) {
        addPackage(rootManifest.resolved, key, 'indirect', scope);
      }
    }
  }

  const submitted = new Map<string, SubmittedDependency['relationship']>();
  for (const manifest of Object.values(manifests)) {
    for (const dependency of Object.values(manifest.resolved)) {
      if (submitted.get(dependency.package_url) !== 'direct') {
        submitted.set(dependency.package_url, dependency.relationship);
      }
    }
  }
  const relationships = [...submitted.values()];
  return {
    manifests,
    stats: {
      packages: submitted.size,
      direct: relationships.filter((relationship) => relationship === 'direct').length,
      indirect: relationships.filter((relationship) => relationship === 'indirect').length,
      skippedExactPins: skipped.size,
      excluded: excludedNames.size,
    },
  };
}

/**
 * GitHub's static analysis matches advisories against the version string a `package.json`
 * declares. Only an exact pin equal to the locked version gives it the lockfile's answer;
 * ranges, `catalog:`, `workspace:` and `npm:` aliases do not. It reads `dependencies`,
 * `devDependencies` and `optionalDependencies`, but not `peerDependencies`. A
 * `name@version` is skipped only when every declaration that installed it is such a pin.
 */
function exactPinsCoveredByPackageJson(
  declarations: readonly Declaration[],
  resolutionOf: (key: string) => { name: string; version: string } | undefined,
): Set<string> {
  const pinned = new Map<string, boolean>();
  for (const declaration of declarations) {
    const resolution = declaration.key ? resolutionOf(declaration.key) : undefined;
    if (resolution) {
      const id = `${resolution.name}@${resolution.version}`;
      const isExactPin =
        declaration.field !== 'peerDependencies' &&
        declaration.name === resolution.name &&
        declaration.specifier === resolution.version;
      pinned.set(id, (pinned.get(id) ?? true) && isExactPin);
    }
  }
  return new Set([...pinned].flatMap(([id, isExactPin]) => (isExactPin ? [id] : [])));
}

/**
 * Builds an npm package URL. The purl spec percent-encodes the scope's `@` and any
 * reserved character in the version, such as `+` in build metadata.
 */
export function toPackageUrl(name: string, version: string): string {
  const path = name.startsWith('@')
    ? name
        .slice(1)
        .split('/')
        .map((part, index) =>
          index === 0 ? `%40${encodeURIComponent(part)}` : encodeURIComponent(part),
        )
        .join('/')
    : encodeURIComponent(name);
  return `pkg:npm/${path}@${encodeURIComponent(version)}`;
}

function compilePatterns(patterns: readonly string[]): (name: string) => boolean {
  if (patterns.length === 0) {
    return () => false;
  }
  const expressions = patterns.map(
    (pattern) =>
      new RegExp(
        `^${pattern
          .split('*')
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')}$`,
      ),
  );
  return (name) => expressions.some((expression) => expression.test(name));
}

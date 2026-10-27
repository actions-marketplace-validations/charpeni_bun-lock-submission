import {
  DEPENDENCY_FIELDS,
  isRegistryVersion,
  packageInfo,
  resolveKey,
  splitResolution,
} from './lockfile.ts';

import type { BunLock, DependencyField } from './lockfile.ts';

export type Scope = 'runtime' | 'development';

/** One dependency a workspace's `package.json` declares, and the lockfile key it installed. */
export type Declaration = {
  /** The workspace's directory relative to the lockfile, `''` for the root. */
  workspace: string;
  field: DependencyField;
  name: string;
  specifier: string;
  /** Missing when nothing was installed, such as an optional peer. */
  key: string | undefined;
};

export type LockfileGraph = {
  declarations: Declaration[];
  /** Every installed package reachable from a workspace, keyed by lockfile key. */
  scopes: Map<string, Scope>;
  /** The lockfile keys a package's own dependencies resolve to. */
  dependenciesOf: (key: string) => string[];
};

/**
 * Walks a lockfile from its workspaces. A package is `runtime` when any path to it starts
 * from a workspace's `dependencies`, `optionalDependencies` or `peerDependencies`, and
 * `development` when every path starts from `devDependencies`.
 */
export function analyzeLockfile(lock: BunLock): LockfileGraph {
  const { packages } = lock;
  const edges = new Map<string, string[]>();

  const dependenciesOf = (key: string): string[] => {
    const cached = edges.get(key);
    if (cached) {
      return cached;
    }
    const entry = packages[key];
    if (!entry) {
      return [];
    }
    const info = packageInfo(entry);
    // An optional peer is only installed when something else requires it, so it is reached
    // through that path. Following it from here would make a dev-only package runtime.
    const optionalPeers = new Set(info.optionalPeers);
    const names = new Set([
      ...Object.keys(info.dependencies ?? {}),
      ...Object.keys(info.optionalDependencies ?? {}),
      ...Object.keys(info.peerDependencies ?? {}).filter((name) => !optionalPeers.has(name)),
    ]);
    // Bun installs the devDependencies of local `file:` and `link:` packages too.
    if (!isRegistryVersion(splitResolution(entry[0]).version)) {
      for (const name of Object.keys(info.devDependencies ?? {})) {
        names.add(name);
      }
    }
    const resolved = [...names].flatMap((name) => resolveKey(packages, key, name) ?? []);
    edges.set(key, resolved);
    return resolved;
  };

  const declarations: Declaration[] = [];
  for (const [workspace, manifest] of Object.entries(lock.workspaces)) {
    // The root's dependencies are hoisted; a workspace's own copies nest under its name.
    const fromKey = workspace === '' ? '' : (manifest.name ?? '');
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
        declarations.push({
          workspace,
          field,
          name,
          specifier,
          key: resolveKey(packages, fromKey, name),
        });
      }
    }
  }

  const scopes = new Map<string, Scope>();
  const visit = (roots: string[], scope: Scope) => {
    const stack = [...roots];
    while (stack.length > 0) {
      const key = stack.pop()!;
      if (scopes.has(key)) {
        continue;
      }
      scopes.set(key, scope);
      stack.push(...dependenciesOf(key));
    }
  };
  const rootsFor = (development: boolean) =>
    declarations.flatMap((declaration) =>
      (declaration.field === 'devDependencies') === development && declaration.key
        ? [declaration.key]
        : [],
    );
  // Runtime first, so a package reachable both ways keeps `runtime`.
  visit(rootsFor(false), 'runtime');
  visit(rootsFor(true), 'development');

  return { declarations, scopes, dependenciesOf };
}

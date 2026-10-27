/** Reading Bun's text lockfile, `bun.lock`, and following its dependency keys. */

export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

type DependencyMaps = Partial<Record<DependencyField, Record<string, string>>>;

/** A package's metadata in `packages`. Bun lists optional peers' names in `optionalPeers`. */
export type PackageInfo = DependencyMaps & { optionalPeers?: string[] };

export type Workspace = DependencyMaps & { name?: string };

/**
 * A `packages` entry. Its shape depends on how the package was resolved:
 * - npm: `["name@version", registry, info, integrity]`
 * - `file:` and `link:`: `["name@file:path", info]`
 * - tarball: `["name@url", info]`
 * - git and github: `["name@git+url", info, tag]`
 * - workspace: `["name@workspace:path"]`
 */
export type PackageEntry = [string, ...unknown[]];

export type BunLock = {
  lockfileVersion: number;
  workspaces: Record<string, Workspace>;
  packages: Record<string, PackageEntry>;
};

/** The newest `lockfileVersion` this parser has been checked against. */
export const LATEST_KNOWN_LOCKFILE_VERSION = 3;

export class LockfileError extends Error {
  override name = 'LockfileError';
}

/**
 * Parses JSON that may contain trailing commas and comments, which `bun.lock` uses.
 * Commas and slashes inside strings are left alone.
 */
export function parseJsonc(text: string): unknown {
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index = skipString(text, index);
    } else if (char === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      parts.push(text.slice(start, index));
      index = skipComment(text, index);
      start = index;
    } else if (char === ',') {
      const next = text[skipInsignificant(text, index + 1)];
      if (next === '}' || next === ']') {
        parts.push(text.slice(start, index));
        start = index + 1;
      }
      index++;
    } else {
      index++;
    }
  }
  parts.push(text.slice(start));
  return JSON.parse(parts.join(''));
}

function skipString(text: string, quote: number): number {
  let index = quote + 1;
  while (index < text.length && text[index] !== '"') {
    index += text[index] === '\\' ? 2 : 1;
  }
  return index + 1;
}

function skipComment(text: string, slash: number): number {
  if (text[slash + 1] === '/') {
    const end = text.indexOf('\n', slash);
    return end === -1 ? text.length : end;
  }
  const end = text.indexOf('*/', slash + 2);
  return end === -1 ? text.length : end + 2;
}

function skipInsignificant(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const char = text[index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index++;
    } else if (char === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
      index = skipComment(text, index);
    } else {
      break;
    }
  }
  return index;
}

/** Parses and shape-checks the contents of a `bun.lock` file. */
export function parseLockfile(text: string): BunLock {
  let value: unknown;
  try {
    value = parseJsonc(text);
  } catch (error) {
    throw new LockfileError(
      `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value) || !isRecord(value.workspaces) || !isRecord(value.packages)) {
    throw new LockfileError('Expected an object with `workspaces` and `packages`.');
  }
  if (typeof value.lockfileVersion !== 'number') {
    throw new LockfileError('Expected a numeric `lockfileVersion`.');
  }
  for (const [key, entry] of Object.entries(value.packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
      throw new LockfileError(`Package "${key}" is not a ["name@version", ...] entry.`);
    }
  }
  return value as BunLock;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Splits a resolution such as `@scope/name@1.2.3` or `name@git+ssh://git@host/repo`
 * at the first `@` after the package name.
 */
export function splitResolution(resolution: string): { name: string; version: string } {
  const searchFrom = resolution.startsWith('@') ? resolution.indexOf('/') + 1 : 1;
  const at = resolution.indexOf('@', Math.max(searchFrom, 1));
  if (at === -1) {
    throw new LockfileError(`Cannot read a name and version from "${resolution}".`);
  }
  return { name: resolution.slice(0, at), version: resolution.slice(at + 1) };
}

/** True for versions resolved from an npm registry, as opposed to `workspace:`, `file:`, git or tarball entries. */
export function isRegistryVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+/.test(version);
}

/** The metadata object of an entry, which sits at index 2 for npm packages and index 1 otherwise. */
export function packageInfo(entry: PackageEntry): PackageInfo {
  const info = entry.slice(1).find(isRecord);
  return (info ?? {}) as PackageInfo;
}

/**
 * Splits a `packages` key into install names: `a/@scope/b/c` becomes `a`, `@scope/b`, `c`.
 * Install names differ from package names for `npm:` aliases.
 */
export function splitKey(key: string): string[] {
  const parts = key.split('/');
  const names: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] ?? '';
    if (part.startsWith('@') && index + 1 < parts.length) {
      names.push(`${part}/${parts[index + 1]}`);
      index++;
    } else {
      names.push(part);
    }
  }
  return names;
}

/**
 * Finds the `packages` key that `dependency` resolves to from the package at `fromKey`,
 * the way Bun nests them: `a/b/dep`, then `a/dep`, then the hoisted `dep`.
 * Workspaces look up their own dependencies from their package name.
 */
export function resolveKey(
  packages: BunLock['packages'],
  fromKey: string,
  dependency: string,
): string | undefined {
  const names = fromKey === '' ? [] : splitKey(fromKey);
  for (let length = names.length; length > 0; length--) {
    const candidate = [...names.slice(0, length), dependency].join('/');
    if (candidate in packages) {
      return candidate;
    }
  }
  return dependency in packages ? dependency : undefined;
}

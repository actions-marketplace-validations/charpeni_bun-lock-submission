import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);

/**
 * Finds `bun.lock` files under `directory`, skipping `node_modules` and `.git`, and returns
 * their paths relative to `root` with forward slashes, sorted. Directories that only have
 * the legacy binary `bun.lockb` are returned separately, since it cannot be read.
 */
export function findLockfiles(
  root: string,
  directory: string = root,
): { lockfiles: string[]; binaryOnly: string[] } {
  const lockfiles: string[] = [];
  const binaryOnly: string[] = [];
  const walk = (current: string) => {
    const entries = readdirSync(current, { withFileTypes: true });
    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const path = (name: string) => relative(root, join(current, name)).split('\\').join('/');
    if (files.has('bun.lock')) {
      lockfiles.push(path('bun.lock'));
    } else if (files.has('bun.lockb')) {
      binaryOnly.push(path('bun.lockb'));
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
        walk(join(current, entry.name));
      }
    }
  };
  walk(directory);
  return { lockfiles: lockfiles.toSorted(), binaryOnly: binaryOnly.toSorted() };
}

/**
 * Regenerates the project fixtures under `fixtures/projects`.
 *
 * Each fixture names a template project and a Bun version. This script copies the
 * template to a temporary directory, installs it with that Bun version, keeps the
 * `bun.lock` it wrote, and records what was actually installed in `installed.json`.
 * It reads `node_modules` the way Node resolves modules, and never reads `bun.lock`,
 * so the tests can check the lockfile parser against Bun's own install.
 *
 * An existing `bun.lock` is reused with `--frozen-lockfile`, so regenerating does not
 * pick up new releases. Delete a fixture's `bun.lock` to resolve it again.
 *
 * Needs network access. Point FIXTURE_BUN_<version> (dots as underscores, such as
 * FIXTURE_BUN_1_2_23) at a Bun binary, or the script runs `bunx bun@<version>`.
 *
 *   bun packages/core/scripts/generate-fixtures.ts [fixture...]
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InstalledProject } from '../fixtures/installed.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

type PackageJson = {
  name?: string;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
};

const readPackageJson = (directory: string): PackageJson =>
  JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));

const idOf = (directory: string) => {
  const { name, version } = readPackageJson(directory);
  return `${name}@${version}`;
};

function bun(version: string, args: string[], cwd: string): void {
  const binary = process.env[`FIXTURE_BUN_${version.replaceAll('.', '_')}`];
  const [file, ...prefix] = binary ? [binary] : ['bunx', `bun@${version}`];
  execFileSync(file!, [...prefix, ...args], { cwd, stdio: 'inherit' });
}

/** Node's lookup: the closest `node_modules/<name>` from `directory` up to `root`. */
function resolveFrom(directory: string, name: string, root: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      return realpathSync(candidate);
    }
    if (current === root || dirname(current) === current) {
      return undefined;
    }
  }
}

/** Expands the root package.json's workspace globs, which are all `dir/*` or plain paths here. */
function workspaceDirectories(root: string): string[] {
  const { workspaces } = readPackageJson(root);
  const patterns = Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? []);
  return [
    '',
    ...patterns.flatMap((pattern) =>
      pattern.endsWith('/*')
        ? readdirSync(join(root, pattern.slice(0, -2))).map(
            (name) => `${pattern.slice(0, -2)}/${name}`,
          )
        : [pattern],
    ),
  ];
}

const NON_REGISTRY = /^(file:|link:|workspace:|github:|git\+|git:|https?:)/;
const RUNTIME_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

function inspect(root: string): Omit<InstalledProject, 'bun' | 'lockfileVersion'> {
  const workspaceDirectoriesByPath = workspaceDirectories(root).map((path) => ({
    path,
    directory: realpathSync(join(root, path)),
  }));
  const workspaceRoots = new Set(workspaceDirectoriesByPath.map(({ directory }) => directory));

  // What each workspace declares, and the installed directories those declarations reach.
  const workspaces: InstalledProject['workspaces'] = {};
  const nonRegistry = new Set<string>();
  const roots = { runtime: [] as string[], development: [] as string[] };
  for (const { path, directory } of workspaceDirectoriesByPath) {
    const manifest = readPackageJson(directory);
    for (const field of [...RUNTIME_FIELDS, 'devDependencies'] as const) {
      const scope = field === 'devDependencies' ? 'development' : 'runtime';
      for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
        const installed = resolveFrom(directory, name, root);
        if (!installed || workspaceRoots.has(installed)) {
          continue;
        }
        roots[scope].push(installed);
        if (NON_REGISTRY.test(specifier)) {
          nonRegistry.add(installed);
          continue;
        }
        (workspaces[path] ??= {})[name] = { id: idOf(installed), field, scope, specifier };
      }
    }
  }

  // Walk the installed tree, runtime roots first so shared packages stay runtime.
  const scopes = new Map<string, 'runtime' | 'development'>();
  const children = new Map<string, string[]>();
  const skippedOptional = new Set<string>();
  for (const scope of ['runtime', 'development'] as const) {
    const stack = [...roots[scope]];
    while (stack.length > 0) {
      const directory = stack.pop()!;
      if (scopes.has(directory)) {
        continue;
      }
      scopes.set(directory, scope);
      const manifest = readPackageJson(directory);
      // Local packages get their devDependencies installed too; registry packages do not.
      const fields = nonRegistry.has(directory)
        ? ([...RUNTIME_FIELDS, 'devDependencies'] as const)
        : RUNTIME_FIELDS;
      const found: string[] = [];
      for (const field of fields) {
        for (const name of Object.keys(manifest[field] ?? {})) {
          // Optional peers are only installed when something else requires them.
          if (field === 'peerDependencies' && manifest.peerDependenciesMeta?.[name]?.optional) {
            continue;
          }
          const installed = resolveFrom(directory, name, root);
          if (!installed) {
            if (field === 'optionalDependencies') {
              skippedOptional.add(name);
            }
          } else if (!workspaceRoots.has(installed)) {
            found.push(installed);
          }
        }
      }
      children.set(directory, found);
      stack.push(...found);
    }
  }

  // Group installed directories by name@version, leaving out non-registry packages.
  const direct = new Set(
    Object.values(workspaces).flatMap((declared) => Object.values(declared).map(({ id }) => id)),
  );
  const packages: InstalledProject['packages'] = {};
  for (const [directory, scope] of scopes) {
    if (nonRegistry.has(directory)) {
      continue;
    }
    const id = idOf(directory);
    const record = (packages[id] ??= { scope, dependencies: [] });
    if (scope === 'runtime') {
      record.scope = 'runtime';
    }
    if (direct.has(id)) {
      record.direct = true;
    }
    const ids = (children.get(directory) ?? [])
      .filter((child) => !nonRegistry.has(child))
      .map(idOf);
    record.dependencies = [...new Set([...record.dependencies, ...ids])].toSorted();
  }
  return {
    platform: `${process.platform}-${process.arch}`,
    workspaces,
    packages: Object.fromEntries(
      Object.entries(packages).toSorted(([a], [b]) => a.localeCompare(b)),
    ),
    skippedOptional: [...skippedOptional].toSorted(),
  };
}

const selected = process.argv.slice(2);
for (const fixture of readdirSync(join(FIXTURES, 'projects')).toSorted()) {
  if (selected.length > 0 && !selected.includes(fixture)) {
    continue;
  }
  const output = join(FIXTURES, 'projects', fixture);
  const { template, bun: version } = JSON.parse(
    readFileSync(join(output, 'fixture.json'), 'utf8'),
  ) as {
    template: string;
    bun: string;
  };
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `fixture-${fixture}-`)));
  try {
    cpSync(join(FIXTURES, 'templates', template), directory, { recursive: true });
    const lockfile = join(output, 'bun.lock');
    const frozen = existsSync(lockfile);
    if (frozen) {
      cpSync(lockfile, join(directory, 'bun.lock'));
    }
    console.log(
      `\n${fixture}: Bun ${version}, template ${template}${frozen ? ', frozen lockfile' : ''}`,
    );
    // Bun 1.1 writes the binary bun.lockb unless asked for the text lockfile.
    const textLockfile = version.startsWith('1.1.') ? ['--save-text-lockfile'] : [];
    bun(
      version,
      ['install', '--ignore-scripts', ...textLockfile, ...(frozen ? ['--frozen-lockfile'] : [])],
      directory,
    );
    cpSync(join(directory, 'bun.lock'), lockfile);
    const { lockfileVersion } = JSON.parse(
      readFileSync(lockfile, 'utf8').replaceAll(/,(\s*[}\]])/g, '$1'),
    ) as { lockfileVersion: number };
    const installed: InstalledProject = { bun: version, lockfileVersion, ...inspect(directory) };
    writeFileSync(join(output, 'installed.json'), `${JSON.stringify(installed, null, 2)}\n`);
    console.log(
      `${fixture}: lockfileVersion ${lockfileVersion}, ${Object.keys(installed.packages).length} registry packages installed, in ${relative(process.cwd(), output)}`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

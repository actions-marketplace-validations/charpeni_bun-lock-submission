import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { LATEST_KNOWN_LOCKFILE_VERSION, LockfileError, parseLockfile } from './lockfile.ts';
import { buildManifests } from './manifests.ts';

import type { Manifest, ManifestOptions, ManifestStats } from './manifests.ts';

export const DETECTOR_NAME = 'bun-lock-submission';
export const DETECTOR_URL = 'https://github.com/charpeni/bun-lock-submission';
export const DEFAULT_CORRELATOR = 'bun-lock-submission';

/** A request body for `POST /repos/{owner}/{repo}/dependency-graph/snapshots`. */
export type Snapshot = {
  version: 0;
  sha: string;
  ref: string;
  job: { correlator: string; id: string; html_url?: string };
  detector: { name: string; version: string; url: string };
  scanned: string;
  manifests: Record<string, Manifest>;
};

export type LockfileReport = { path: string; lockfileVersion: number; stats: ManifestStats };

/**
 * Reads lockfiles and builds their manifests. `lockfiles` are paths relative to `root`,
 * the repository root, because GitHub names manifests by their path in the repository.
 */
export function readManifests(
  root: string,
  lockfiles: readonly string[],
  options: ManifestOptions = {},
): { manifests: Record<string, Manifest>; reports: LockfileReport[]; warnings: string[] } {
  const manifests: Record<string, Manifest> = {};
  const reports: LockfileReport[] = [];
  const warnings: string[] = [];
  const owners = new Map<string, string>();
  // `./bun.lock`, `bun.lock` and `.\\bun.lock` name the same manifest.
  const paths = new Set(lockfiles.map((path) => posix.normalize(path.split('\\').join('/'))));
  for (const posixPath of paths) {
    let text: string;
    try {
      text = readFileSync(join(root, posixPath), 'utf8');
    } catch (error) {
      throw new LockfileError(`${posixPath}: ${error instanceof Error ? error.message : error}`);
    }
    let lock;
    try {
      lock = parseLockfile(text);
    } catch (error) {
      throw new LockfileError(`${posixPath}: ${error instanceof Error ? error.message : error}`);
    }
    if (lock.lockfileVersion > LATEST_KNOWN_LOCKFILE_VERSION) {
      warnings.push(
        `${posixPath} uses lockfileVersion ${lock.lockfileVersion}; this version of bun-lock-submission was checked against versions up to ${LATEST_KNOWN_LOCKFILE_VERSION}.`,
      );
    }
    const result = buildManifests(posixPath, lock, options);
    for (const [name, manifest] of Object.entries(result.manifests)) {
      // In the workspaces layout, a lockfile inside another lockfile's workspace would
      // replace that workspace's manifest. Bun only reads the outer one.
      const owner = owners.get(name);
      if (owner) {
        throw new LockfileError(
          `${posixPath} and ${owner} both describe ${name}. Bun only uses the outer lockfile for a workspace, so list the lockfiles to submit, or delete the stale one.`,
        );
      }
      owners.set(name, posixPath);
      manifests[name] = manifest;
    }
    reports.push({ path: posixPath, lockfileVersion: lock.lockfileVersion, stats: result.stats });
  }
  return { manifests, reports, warnings };
}

export type SnapshotInput = {
  manifests: Record<string, Manifest>;
  /** The commit the lockfiles were read from. */
  sha: string;
  /** The fully qualified ref, such as `refs/heads/main`. */
  ref: string;
  /**
   * GitHub keeps the latest snapshot per correlator and detector, and replaces it as a
   * whole: a manifest missing from the next snapshot is removed.
   */
  correlator?: string;
  jobId: string;
  jobUrl?: string | undefined;
  detectorVersion: string;
  /** Defaults to now. GitHub ignores a snapshot older than the latest one for its correlator. */
  scanned?: Date;
};

export function createSnapshot(input: SnapshotInput): Snapshot {
  return {
    version: 0,
    sha: input.sha,
    ref: input.ref,
    job: {
      correlator: input.correlator ?? DEFAULT_CORRELATOR,
      id: input.jobId,
      ...(input.jobUrl ? { html_url: input.jobUrl } : {}),
    },
    detector: { name: DETECTOR_NAME, version: input.detectorVersion, url: DETECTOR_URL },
    scanned: (input.scanned ?? new Date()).toISOString(),
    manifests: input.manifests,
  };
}

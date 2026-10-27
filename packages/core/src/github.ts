import type { Snapshot } from './snapshot.ts';

export type SubmissionResult = {
  id: number;
  createdAt: string;
  /**
   * `SUCCESS`: the dependency graph was updated. `ACCEPTED`: the snapshot was stored but
   * not applied, which happens for a ref other than the default branch, or when a
   * snapshot with a later `scanned` time already exists for the correlator.
   */
  result: 'SUCCESS' | 'ACCEPTED' | 'INVALID' | (string & {});
  message: string;
};

export class SubmissionError extends Error {
  override name = 'SubmissionError';
  /** The HTTP status, or 0 when GitHub could not be reached. */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type SubmitOptions = {
  /** `owner/name`. */
  repository: string;
  token: string;
  /** Defaults to `https://api.github.com`. */
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export async function submitSnapshot(
  snapshot: Snapshot,
  options: SubmitOptions,
): Promise<SubmissionResult> {
  const {
    repository,
    token,
    apiUrl = 'https://api.github.com',
    fetch = globalThis.fetch,
  } = options;
  const url = `${apiUrl.replace(/\/+$/, '')}/repos/${repository}/dependency-graph/snapshots`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'bun-lock-submission',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(snapshot),
  }).catch((error: unknown) => {
    throw new SubmissionError(
      `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  });
  const text = await response.text();
  if (!response.ok) {
    throw new SubmissionError(describeFailure(response.status, text, repository), response.status);
  }
  const body = JSON.parse(text) as {
    id: number;
    created_at: string;
    result: string;
    message: string;
  };
  return { id: body.id, createdAt: body.created_at, result: body.result, message: body.message };
}

function describeFailure(status: number, body: string, repository: string): string {
  let message = body;
  try {
    message = (JSON.parse(body) as { message?: string }).message ?? body;
  } catch {
    // Not JSON: keep the raw body.
  }
  const hint =
    status === 401
      ? ' Check that the token is valid.'
      : status === 403
        ? ' The token needs the `contents: write` permission on the repository.'
        : status === 404
          ? ` Check that ${repository} exists, that the token can see it, and that its dependency graph is enabled.`
          : '';
  return `GitHub rejected the snapshot (HTTP ${status}): ${message}.${hint}`;
}

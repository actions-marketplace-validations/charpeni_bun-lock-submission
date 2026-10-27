// src/main.ts
import { readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { join as join3, relative as relative2, resolve } from "node:path";

// ../core/src/discover.ts
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
var SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);
function findLockfiles(root, directory = root) {
  const lockfiles = [];
  const binaryOnly = [];
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true });
    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const path = (name) => relative(root, join(current, name)).split("\\").join("/");
    if (files.has("bun.lock")) {
      lockfiles.push(path("bun.lock"));
    } else if (files.has("bun.lockb")) {
      binaryOnly.push(path("bun.lockb"));
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
// ../core/src/github.ts
class SubmissionError extends Error {
  name = "SubmissionError";
  status;
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
async function submitSnapshot(snapshot, options) {
  const {
    repository,
    token,
    apiUrl = "https://api.github.com",
    fetch = globalThis.fetch
  } = options;
  const url = `${apiUrl.replace(/\/+$/, "")}/repos/${repository}/dependency-graph/snapshots`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "bun-lock-submission",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify(snapshot)
  }).catch((error) => {
    throw new SubmissionError(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`, 0);
  });
  const text = await response.text();
  if (!response.ok) {
    throw new SubmissionError(describeFailure(response.status, text, repository), response.status);
  }
  const body = JSON.parse(text);
  return { id: body.id, createdAt: body.created_at, result: body.result, message: body.message };
}
function describeFailure(status, body, repository) {
  let message = body;
  try {
    message = JSON.parse(body).message ?? body;
  } catch {}
  const hint = status === 401 ? " Check that the token is valid." : status === 403 ? " The token needs the `contents: write` permission on the repository." : status === 404 ? ` Check that ${repository} exists, that the token can see it, and that its dependency graph is enabled.` : "";
  return `GitHub rejected the snapshot (HTTP ${status}): ${message}.${hint}`;
}
// ../core/src/lockfile.ts
var DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];
var LATEST_KNOWN_LOCKFILE_VERSION = 3;

class LockfileError extends Error {
  name = "LockfileError";
}
function parseJsonc(text) {
  const parts = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index = skipString(text, index);
    } else if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
      parts.push(text.slice(start, index));
      index = skipComment(text, index);
      start = index;
    } else if (char === ",") {
      const next = text[skipInsignificant(text, index + 1)];
      if (next === "}" || next === "]") {
        parts.push(text.slice(start, index));
        start = index + 1;
      }
      index++;
    } else {
      index++;
    }
  }
  parts.push(text.slice(start));
  return JSON.parse(parts.join(""));
}
function skipString(text, quote) {
  let index = quote + 1;
  while (index < text.length && text[index] !== '"') {
    index += text[index] === "\\" ? 2 : 1;
  }
  return index + 1;
}
function skipComment(text, slash) {
  if (text[slash + 1] === "/") {
    const end = text.indexOf(`
`, slash);
    return end === -1 ? text.length : end;
  }
  const end = text.indexOf("*/", slash + 2);
  return end === -1 ? text.length : end + 2;
}
function skipInsignificant(text, from) {
  let index = from;
  while (index < text.length) {
    const char = text[index];
    if (char === " " || char === "\t" || char === `
` || char === "\r") {
      index++;
    } else if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
      index = skipComment(text, index);
    } else {
      break;
    }
  }
  return index;
}
function parseLockfile(text) {
  let value;
  try {
    value = parseJsonc(text);
  } catch (error) {
    throw new LockfileError(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value) || !isRecord(value.workspaces) || !isRecord(value.packages)) {
    throw new LockfileError("Expected an object with `workspaces` and `packages`.");
  }
  if (typeof value.lockfileVersion !== "number") {
    throw new LockfileError("Expected a numeric `lockfileVersion`.");
  }
  for (const [key, entry] of Object.entries(value.packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      throw new LockfileError(`Package "${key}" is not a ["name@version", ...] entry.`);
    }
  }
  return value;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function splitResolution(resolution) {
  const searchFrom = resolution.startsWith("@") ? resolution.indexOf("/") + 1 : 1;
  const at = resolution.indexOf("@", Math.max(searchFrom, 1));
  if (at === -1) {
    throw new LockfileError(`Cannot read a name and version from "${resolution}".`);
  }
  return { name: resolution.slice(0, at), version: resolution.slice(at + 1) };
}
function isRegistryVersion(version) {
  return /^\d+\.\d+\.\d+/.test(version);
}
function packageInfo(entry) {
  const info = entry.slice(1).find(isRecord);
  return info ?? {};
}
function splitKey(key) {
  const parts = key.split("/");
  const names = [];
  for (let index = 0;index < parts.length; index++) {
    const part = parts[index] ?? "";
    if (part.startsWith("@") && index + 1 < parts.length) {
      names.push(`${part}/${parts[index + 1]}`);
      index++;
    } else {
      names.push(part);
    }
  }
  return names;
}
function resolveKey(packages, fromKey, dependency) {
  const names = fromKey === "" ? [] : splitKey(fromKey);
  for (let length = names.length;length > 0; length--) {
    const candidate = [...names.slice(0, length), dependency].join("/");
    if (candidate in packages) {
      return candidate;
    }
  }
  return dependency in packages ? dependency : undefined;
}

// ../core/src/graph.ts
function analyzeLockfile(lock) {
  const { packages } = lock;
  const edges = new Map;
  const dependenciesOf = (key) => {
    const cached = edges.get(key);
    if (cached) {
      return cached;
    }
    const entry = packages[key];
    if (!entry) {
      return [];
    }
    const info = packageInfo(entry);
    const optionalPeers = new Set(info.optionalPeers);
    const names = new Set([
      ...Object.keys(info.dependencies ?? {}),
      ...Object.keys(info.optionalDependencies ?? {}),
      ...Object.keys(info.peerDependencies ?? {}).filter((name) => !optionalPeers.has(name))
    ]);
    if (!isRegistryVersion(splitResolution(entry[0]).version)) {
      for (const name of Object.keys(info.devDependencies ?? {})) {
        names.add(name);
      }
    }
    const resolved = [...names].flatMap((name) => resolveKey(packages, key, name) ?? []);
    edges.set(key, resolved);
    return resolved;
  };
  const declarations = [];
  for (const [workspace, manifest] of Object.entries(lock.workspaces)) {
    const fromKey = workspace === "" ? "" : manifest.name ?? "";
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
        declarations.push({
          workspace,
          field,
          name,
          specifier,
          key: resolveKey(packages, fromKey, name)
        });
      }
    }
  }
  const scopes = new Map;
  const visit = (roots, scope) => {
    const stack = [...roots];
    while (stack.length > 0) {
      const key = stack.pop();
      if (scopes.has(key)) {
        continue;
      }
      scopes.set(key, scope);
      stack.push(...dependenciesOf(key));
    }
  };
  const rootsFor = (development) => declarations.flatMap((declaration) => declaration.field === "devDependencies" === development && declaration.key ? [declaration.key] : []);
  visit(rootsFor(false), "runtime");
  visit(rootsFor(true), "development");
  return { declarations, scopes, dependenciesOf };
}
// ../core/src/manifests.ts
import { posix } from "node:path";
function buildManifests(lockfilePath, lock, options = {}) {
  const { layout = "lockfile", includeExactPins = false, exclude = [] } = options;
  const { declarations, scopes, dependenciesOf } = analyzeLockfile(lock);
  const isExcluded = compilePatterns(exclude);
  const resolutionOf = (key) => {
    const entry = lock.packages[key];
    if (!entry) {
      return;
    }
    const { name, version } = splitResolution(entry[0]);
    return isRegistryVersion(version) && !isExcluded(name) ? { name, version } : undefined;
  };
  const excludedNames = new Set;
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
  const skipped = layout === "lockfile" && !includeExactPins ? exactPinsCoveredByPackageJson(declarations, resolutionOf) : new Set;
  const addPackage = (resolved, key, relationship, scope) => {
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
      if (relationship === "direct") {
        existing.relationship = "direct";
      }
      if (scope === "runtime") {
        existing.scope = "runtime";
      }
      existing.dependencies = [...new Set([...existing.dependencies, ...children])].toSorted();
      return;
    }
    resolved[packageUrl] = {
      package_url: packageUrl,
      relationship,
      scope,
      dependencies: [...new Set(children)].toSorted()
    };
  };
  const manifests = {};
  const manifestAt = (path) => manifests[path] ??= { name: path, file: { source_location: path }, resolved: {} };
  if (layout === "lockfile") {
    const manifest = manifestAt(lockfilePath);
    for (const [key, scope] of scopes) {
      addPackage(manifest.resolved, key, directKeys.has(key) ? "direct" : "indirect", scope);
    }
  } else {
    const directory = posix.dirname(lockfilePath);
    const rootManifest = manifestAt(posix.join(directory, "package.json"));
    for (const workspace of Object.keys(lock.workspaces)) {
      manifestAt(posix.join(directory, workspace, "package.json"));
    }
    for (const declaration of declarations) {
      if (declaration.key) {
        const manifest = manifestAt(posix.join(directory, declaration.workspace, "package.json"));
        const scope = declaration.field === "devDependencies" ? "development" : "runtime";
        addPackage(manifest.resolved, declaration.key, "direct", scope);
      }
    }
    for (const [key, scope] of scopes) {
      if (!directKeys.has(key)) {
        addPackage(rootManifest.resolved, key, "indirect", scope);
      }
    }
  }
  const submitted = new Map;
  for (const manifest of Object.values(manifests)) {
    for (const dependency of Object.values(manifest.resolved)) {
      if (submitted.get(dependency.package_url) !== "direct") {
        submitted.set(dependency.package_url, dependency.relationship);
      }
    }
  }
  const relationships = [...submitted.values()];
  return {
    manifests,
    stats: {
      packages: submitted.size,
      direct: relationships.filter((relationship) => relationship === "direct").length,
      indirect: relationships.filter((relationship) => relationship === "indirect").length,
      skippedExactPins: skipped.size,
      excluded: excludedNames.size
    }
  };
}
function exactPinsCoveredByPackageJson(declarations, resolutionOf) {
  const pinned = new Map;
  for (const declaration of declarations) {
    const resolution = declaration.key ? resolutionOf(declaration.key) : undefined;
    if (resolution) {
      const id = `${resolution.name}@${resolution.version}`;
      const isExactPin = declaration.field !== "peerDependencies" && declaration.name === resolution.name && declaration.specifier === resolution.version;
      pinned.set(id, (pinned.get(id) ?? true) && isExactPin);
    }
  }
  return new Set([...pinned].flatMap(([id, isExactPin]) => isExactPin ? [id] : []));
}
function toPackageUrl(name, version) {
  const path = name.startsWith("@") ? name.slice(1).split("/").map((part, index) => index === 0 ? `%40${encodeURIComponent(part)}` : encodeURIComponent(part)).join("/") : encodeURIComponent(name);
  return `pkg:npm/${path}@${encodeURIComponent(version)}`;
}
function compilePatterns(patterns) {
  if (patterns.length === 0) {
    return () => false;
  }
  const expressions = patterns.map((pattern) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`));
  return (name) => expressions.some((expression) => expression.test(name));
}
// ../core/src/snapshot.ts
import { readFileSync } from "node:fs";
import { join as join2, posix as posix2 } from "node:path";
var DETECTOR_NAME = "bun-lock-submission";
var DETECTOR_URL = "https://github.com/charpeni/bun-lock-submission";
var DEFAULT_CORRELATOR = "bun-lock-submission";
function readManifests(root, lockfiles, options = {}) {
  const manifests = {};
  const reports = [];
  const warnings = [];
  const owners = new Map;
  const paths = new Set(lockfiles.map((path) => posix2.normalize(path.split("\\").join("/"))));
  for (const posixPath of paths) {
    let text;
    try {
      text = readFileSync(join2(root, posixPath), "utf8");
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
      warnings.push(`${posixPath} uses lockfileVersion ${lock.lockfileVersion}; this version of bun-lock-submission was checked against versions up to ${LATEST_KNOWN_LOCKFILE_VERSION}.`);
    }
    const result = buildManifests(posixPath, lock, options);
    for (const [name, manifest] of Object.entries(result.manifests)) {
      const owner = owners.get(name);
      if (owner) {
        throw new LockfileError(`${posixPath} and ${owner} both describe ${name}. Bun only uses the outer lockfile for a workspace, so list the lockfiles to submit, or delete the stale one.`);
      }
      owners.set(name, posixPath);
      manifests[name] = manifest;
    }
    reports.push({ path: posixPath, lockfileVersion: lock.lockfileVersion, stats: result.stats });
  }
  return { manifests, reports, warnings };
}
function createSnapshot(input) {
  return {
    version: 0,
    sha: input.sha,
    ref: input.ref,
    job: {
      correlator: input.correlator ?? DEFAULT_CORRELATOR,
      id: input.jobId,
      ...input.jobUrl ? { html_url: input.jobUrl } : {}
    },
    detector: { name: DETECTOR_NAME, version: input.detectorVersion, url: DETECTOR_URL },
    scanned: (input.scanned ?? new Date).toISOString(),
    manifests: input.manifests
  };
}
// package.json
var package_default = {
  name: "@bun-lock-submission/action",
  version: "1.0.0",
  private: true,
  type: "module",
  scripts: {
    build: "bun build src/index.ts --target node --format esm --outfile dist/index.mjs",
    "type-check": "tsc -p tsconfig.json"
  },
  devDependencies: {
    "@bun-lock-submission/core": "workspace:*"
  }
};

// src/workflow-commands.ts
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
function getInput(env, name) {
  return env[`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`]?.trim() ?? "";
}
function getBooleanInput(env, name) {
  const value = getInput(env, name).toLowerCase();
  if (value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error(`Input "${name}" must be "true" or "false", not "${value}".`);
}
function getMultilineInput(env, name) {
  return getInput(env, name).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
function setOutput(env, name, value) {
  const file = env.GITHUB_OUTPUT;
  if (!file) {
    return;
  }
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}
${value}
${delimiter}
`);
}
function appendSummary(env, markdown) {
  const file = env.GITHUB_STEP_SUMMARY;
  if (file) {
    appendFileSync(file, markdown);
  }
}
function annotation(level, message) {
  const escaped = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll(`
`, "%0A");
  return `::${level}::${escaped}
`;
}

// src/main.ts
async function run(env, { write, fetch }) {
  try {
    const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
    const directory = resolve(workspace, getInput(env, "working-directory") || ".");
    const layout = getInput(env, "layout") || "lockfile";
    if (layout !== "lockfile" && layout !== "workspaces") {
      throw new Error(`Input "layout" must be "lockfile" or "workspaces", not "${layout}".`);
    }
    const correlator = getInput(env, "correlator") || DEFAULT_CORRELATOR;
    const dryRun = getBooleanInput(env, "dry-run");
    const listed = getMultilineInput(env, "lockfiles");
    let lockfiles;
    if (listed.length > 0) {
      lockfiles = listed.map((path) => relative2(workspace, resolve(directory, path)));
    } else {
      const found = findLockfiles(workspace, directory);
      for (const path of found.binaryOnly) {
        write(annotation("warning", `${path} is the legacy binary lockfile, which cannot be read. Run \`bun install --save-text-lockfile\` to write bun.lock.`));
      }
      lockfiles = found.lockfiles;
    }
    if (lockfiles.length === 0) {
      throw new Error(`No bun.lock found under ${relative2(workspace, directory) || "the repository root"}. To remove a previous submission, run \`bunx bun-lock-submission clear\`.`);
    }
    const { manifests, reports, warnings } = readManifests(workspace, lockfiles, {
      layout,
      includeExactPins: getBooleanInput(env, "include-exact-pins"),
      exclude: getMultilineInput(env, "exclude").flatMap((line) => line.split(",").map((part) => part.trim()).filter(Boolean))
    });
    for (const warning of warnings) {
      write(annotation("warning", warning));
    }
    const { sha, ref } = commitOf(env);
    const repository = required(env, "GITHUB_REPOSITORY");
    const runId = env.GITHUB_RUN_ID || `local-${Date.now()}`;
    const snapshot = createSnapshot({
      manifests,
      sha,
      ref,
      correlator,
      jobId: `${runId}-${env.GITHUB_RUN_ATTEMPT ?? "1"}`,
      jobUrl: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${repository}/actions/runs/${env.GITHUB_RUN_ID}` : undefined,
      detectorVersion: package_default.version
    });
    const packageCount = reports.reduce((total, report) => total + report.stats.packages, 0);
    setOutput(env, "manifests", String(Object.keys(manifests).length));
    setOutput(env, "packages", String(packageCount));
    write(describeReports(reports));
    if (dryRun) {
      const path = join3(env.RUNNER_TEMP ?? workspace, "bun-lock-submission-snapshot.json");
      writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}
`);
      setOutput(env, "snapshot-path", path);
      setOutput(env, "result", "DRY_RUN");
      write(`Dry run: wrote the snapshot to ${path} without submitting it.
`);
      appendSummary(env, summary(reports, "Dry run, not submitted", correlator));
      return 0;
    }
    const token = getInput(env, "token");
    if (!token) {
      throw new Error('Input "token" is empty. It defaults to github.token, which needs `contents: write`.');
    }
    const response = await submitSnapshot(snapshot, {
      repository,
      token,
      apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
      ...fetch ? { fetch } : {}
    });
    setOutput(env, "result", response.result);
    setOutput(env, "snapshot-id", String(response.id));
    write(`Submitted ${Object.keys(manifests).length} manifest(s) to ${repository} at ${ref}: ${response.result} (snapshot ${response.id}).
`);
    if (response.result === "ACCEPTED") {
      write(annotation("notice", `GitHub stored the snapshot for ${ref} but did not apply it. Dependabot alerts follow the default branch; otherwise a newer snapshot already exists for the "${correlator}" correlator.`));
    }
    appendSummary(env, summary(reports, response.result, correlator));
    if (response.result === "INVALID") {
      write(annotation("error", `GitHub rejected the snapshot as invalid: ${response.message}`));
      return 1;
    }
    return 0;
  } catch (error) {
    write(annotation("error", error instanceof Error ? error.message : String(error)));
    return 1;
  }
}
function commitOf(env) {
  if (env.GITHUB_EVENT_NAME === "pull_request" && env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync2(env.GITHUB_EVENT_PATH, "utf8"));
    const head = event.pull_request?.head;
    if (head?.sha && head.ref && head.repo?.full_name === env.GITHUB_REPOSITORY) {
      return { sha: head.sha, ref: `refs/heads/${head.ref}` };
    }
  }
  return { sha: required(env, "GITHUB_SHA"), ref: required(env, "GITHUB_REF") };
}
function required(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not set; this action must run in GitHub Actions.`);
  }
  return value;
}
function describeReports(reports) {
  return reports.map(({ path, stats }) => `${path}: ${stats.packages} packages (${stats.direct} direct, ${stats.indirect} transitive, ${stats.skippedExactPins} exact pins left to package.json, ${stats.excluded} excluded)
`).join("");
}
function summary(reports, result, correlator) {
  const rows = reports.map(({ path, stats }) => `| \`${path}\` | ${stats.packages} | ${stats.direct} | ${stats.indirect} | ${stats.skippedExactPins} | ${stats.excluded} |`);
  return [
    "### Bun lockfile dependency submission",
    "",
    `Result: **${result}** (correlator \`${correlator}\`)`,
    "",
    "| Lockfile | Packages | Direct | Transitive | Exact pins left to package.json | Excluded |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    ""
  ].join(`
`);
}

// src/index.ts
process.exitCode = await run(process.env, { write: (text) => process.stdout.write(text) });

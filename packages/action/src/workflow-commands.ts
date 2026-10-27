/** The few GitHub Actions runner features the action needs, without @actions/core. */
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

type Env = Record<string, string | undefined>;

/** Reads an input the way the runner exposes it: `INPUT_` plus the upper-cased name. */
export function getInput(env: Env, name: string): string {
  return env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`]?.trim() ?? '';
}

export function getBooleanInput(env: Env, name: string): boolean {
  const value = getInput(env, name).toLowerCase();
  if (value === '' || value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  throw new Error(`Input "${name}" must be "true" or "false", not "${value}".`);
}

/** Lines of a multiline input, without blanks. */
export function getMultilineInput(env: Env, name: string): string[] {
  return getInput(env, name)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function setOutput(env: Env, name: string, value: string): void {
  const file = env.GITHUB_OUTPUT;
  if (!file) {
    return;
  }
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function appendSummary(env: Env, markdown: string): void {
  const file = env.GITHUB_STEP_SUMMARY;
  if (file) {
    appendFileSync(file, markdown);
  }
}

/** Formats a `::warning::` or `::error::` annotation. */
export function annotation(level: 'notice' | 'warning' | 'error', message: string): string {
  const escaped = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  return `::${level}::${escaped}\n`;
}

import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CORRELATOR } from '@bun-lock-submission/core';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type ActionYml = {
  inputs: Record<string, { default?: string }>;
  outputs: Record<string, { description: string }>;
  runs: { using: string; main: string };
};

const action = Bun.YAML.parse(readFileSync(`${ROOT}action.yml`, 'utf8')) as ActionYml;
const source = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
const namesIn = (pattern: RegExp) =>
  [...new Set([...source.matchAll(pattern)].map((match) => match[1]))].toSorted();

test('declares exactly the inputs the action reads', () => {
  expect(namesIn(/get(?:Boolean|Multiline)?Input\(env, '([^']+)'\)/g)).toEqual(
    Object.keys(action.inputs).toSorted(),
  );
});

test('declares exactly the outputs the action sets', () => {
  expect(namesIn(/setOutput\(env, '([^']+)'/g)).toEqual(Object.keys(action.outputs).toSorted());
});

test('declares the defaults the action assumes', () => {
  expect(
    Object.fromEntries(Object.entries(action.inputs).map(([name, input]) => [name, input.default])),
  ).toEqual({
    'working-directory': '.',
    lockfiles: '',
    layout: 'lockfile',
    'include-exact-pins': 'false',
    exclude: '',
    correlator: DEFAULT_CORRELATOR,
    token: '${{ github.token }}',
    'dry-run': 'false',
  });
});

test('runs the committed bundle on a supported Node.js runtime', () => {
  expect(action.runs.using).toBe('node24');
  expect(existsSync(`${ROOT}${action.runs.main}`)).toBe(true);
});

import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  annotation,
  getBooleanInput,
  getInput,
  getMultilineInput,
  setOutput,
} from './workflow-commands.ts';

test('reads inputs the way the runner names them', () => {
  const env = {
    'INPUT_WORKING-DIRECTORY': '  apps  ',
    'INPUT_DRY-RUN': 'TRUE',
    INPUT_LOCKFILES: 'a\n\n  b \n',
  };
  expect(getInput(env, 'working-directory')).toBe('apps');
  expect(getInput(env, 'missing')).toBe('');
  expect(getBooleanInput(env, 'dry-run')).toBe(true);
  expect(getBooleanInput(env, 'missing')).toBe(false);
  expect(getMultilineInput(env, 'lockfiles')).toEqual(['a', 'b']);
});

test('escapes annotations so a message cannot inject workflow commands', () => {
  expect(annotation('error', 'line one\nline two 100%\r')).toBe(
    '::error::line one%0Aline two 100%25%0D\n',
  );
});

test('writes multiline outputs with a delimiter, and nothing without GITHUB_OUTPUT', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'outputs-')), 'output');
  writeFileSync(file, '');
  setOutput({ GITHUB_OUTPUT: file }, 'path', 'first\nsecond');
  const [header, ...rest] = readFileSync(file, 'utf8').split('\n');
  const delimiter = header!.split('<<')[1]!;
  expect(header).toStartWith('path<<ghadelimiter_');
  expect(rest).toEqual(['first', 'second', delimiter, '']);
  expect(() => setOutput({}, 'path', 'value')).not.toThrow();
});

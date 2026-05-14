import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: options.env ?? process.env,
  });
}

test('codex-task help documents the JSON contract and permission modes', () => {
  const result = runNode(['codex-task.mjs', '--help']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--permissions read-only\|workspace-write\|danger-full-access/);
  assert.match(result.stdout, /--stream-thinking/);
  assert.match(result.stdout, /--track-references/);
  assert.match(result.stdout, /Output: JSON on stdout/);
});

test('codex-task rejects deprecated full-auto permission value', () => {
  const result = runNode(['codex-task.mjs', '--permissions', 'full-auto', '--prompt', 'noop']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--permissions must be one of: read-only, workspace-write, danger-full-access/);
});

test('codex-task surfaces missing codex CLI as structured JSON', () => {
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--quiet'], {
    env: { ...process.env, PATH: '' },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.taskResult, 'failed');
  assert.equal(parsed.sessionDir, null);
  assert.match(parsed.error, /codex CLI was not found on PATH|failed to run "codex --version"/);
});

test('codex-task filters references and suppresses live codex output by default', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop'], {
    env: { ...process.env, PATH: `${fake.dir}${delimiter}${process.env.PATH}` },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.taskResult, 'completed');
  assert.deepEqual(parsed.files, { 'src/changed.js': 'edited' });
});

test('codex-task can track references and opt into streaming codex output', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--track-references', '--stream-thinking'], {
    env: { ...process.env, PATH: `${fake.dir}${delimiter}${process.env.PATH}` },
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /FAKE_STDOUT/);
  assert.match(result.stderr, /FAKE_STDERR/);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.taskResult, 'completed');
  assert.deepEqual(parsed.files, {
    'src/context.js': 'referenced',
    'src/changed.js': 'edited',
  });
});

test('installer lists all supported harness targets without requiring codex', () => {
  const result = runNode(['install.mjs', '--list-targets']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  for (const target of ['claude', 'opencode', 'cline', 'cursor', 'agents']) {
    assert.match(result.stdout, new RegExp(`\\b${target}\\b`));
  }
});

function makeFakeCodex() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-task-test-'));
  const resultJson = '{"taskResult":"completed","summary":"done","details":"ok","files":{"src/context.js":"referenced","src/changed.js":"edited"}}';
  if (process.platform === 'win32') {
    const shim = [
      '@echo off',
      'node "%~dp0fake-codex.mjs" %*',
      '',
    ].join('\r\n');
    writeFileSync(join(dir, 'codex.cmd'), shim);
    writeFileSync(join(dir, 'fake-codex.mjs'), fakeCodexJs(resultJson));
  } else {
    const script = [
      '#!/bin/sh',
      'node "$(dirname "$0")/fake-codex.mjs" "$@"',
      '',
    ].join('\n');
    const path = join(dir, 'codex');
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    writeFileSync(join(dir, 'fake-codex.mjs'), fakeCodexJs(resultJson));
  }
  return { dir };
}

function fakeCodexJs(resultJson) {
  return [
    "import { writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') {",
    "  console.log('codex-test 0.0.0');",
    '  process.exit(0);',
    '}',
    "console.log('FAKE_STDOUT');",
    "console.error('FAKE_STDERR');",
    "const i = args.indexOf('--output-last-message');",
    "if (i === -1 || !args[i + 1]) process.exit(2);",
    `writeFileSync(args[i + 1], ${JSON.stringify(resultJson)} + '\\n');`,
    '',
  ].join('\n');
}

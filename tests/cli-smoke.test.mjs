import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Default test env skips the not-installed skill check so results don't
// depend on what happens to be registered on the machine running the tests.
// The install-check tests build their own env without this variable.
const baseEnv = { ...process.env, CODEX_TASK_SKIP_INSTALL_CHECK: '1' };

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: options.env ?? baseEnv,
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
  assert.match(result.stdout, /--reasoning-effort/);
  assert.match(result.stdout, /--no-install-check/);
  assert.match(result.stdout, /--install/);
  assert.match(result.stdout, /Output: JSON on stdout/);
});

test('codex-task rejects deprecated full-auto permission value', () => {
  const result = runNode(['codex-task.mjs', '--permissions', 'full-auto', '--prompt', 'noop']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--permissions must be one of: read-only, workspace-write, danger-full-access/);
});

test('codex-task surfaces missing codex CLI as structured JSON', () => {
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--quiet'], {
    env: { ...baseEnv, PATH: '' },
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
    env: { ...baseEnv, PATH: `${fake.dir}${delimiter}${process.env.PATH}` },
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
    env: { ...baseEnv, PATH: `${fake.dir}${delimiter}${process.env.PATH}` },
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

test('codex-task rejects --reasoning-effort with no value', () => {
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--reasoning-effort']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--reasoning-effort requires a value/);
});

test('codex-task composes -c model_reasoning_effort and echoes reasoningEffort when set', () => {
  const fake = makeFakeCodex();
  const argvOut = join(fake.dir, 'argv-out.json');
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--reasoning-effort', 'high'], {
    env: {
      ...baseEnv,
      PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
      FAKE_CODEX_ARGV_OUT: argvOut,
    },
  });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.reasoningEffort, 'high');

  const argv = JSON.parse(readFileSync(argvOut, 'utf8'));
  const cIndex = argv.indexOf('-c');
  assert.notEqual(cIndex, -1);
  assert.match(argv[cIndex + 1], /^model_reasoning_effort=("?)high\1$/);
});

test('codex-task omits -c and reports reasoningEffort null when unset', () => {
  const fake = makeFakeCodex();
  const argvOut = join(fake.dir, 'argv-out.json');
  const result = runNode(['codex-task.mjs', '--prompt', 'noop'], {
    env: {
      ...baseEnv,
      PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
      FAKE_CODEX_ARGV_OUT: argvOut,
    },
  });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.reasoningEffort, null);

  const argv = JSON.parse(readFileSync(argvOut, 'utf8'));
  assert.equal(argv.indexOf('-c'), -1);
});

test('installer lists all supported harness targets without requiring codex', () => {
  const result = runNode(['install.mjs', '--list-targets']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  for (const target of ['claude', 'opencode', 'cline', 'cursor', 'agents']) {
    assert.match(result.stdout, new RegExp(`\\b${target}\\b`));
  }
});

test('codex-task --list-targets forwards to the installer', () => {
  const result = runNode(['codex-task.mjs', '--list-targets']);

  assert.equal(result.status, 0);
  for (const target of ['claude', 'opencode', 'cline', 'cursor', 'agents']) {
    assert.match(result.stdout, new RegExp(`\\b${target}\\b`));
  }
});

// Env for the install-check tests: no skip variable, and HOME/USERPROFILE
// pointed at a controlled temp dir so the probe result is deterministic
// regardless of what is installed on the machine running the tests.
function installCheckEnv(homeDir, extra = {}) {
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  delete env.CODEX_TASK_SKIP_INSTALL_CHECK;
  return { ...env, ...extra };
}

test('codex-task warns when the skill is not registered with any harness', () => {
  const fake = makeFakeCodex();
  const home = mkdtempSync(join(tmpdir(), 'codex-task-home-'));
  const result = runNode(['codex-task.mjs', '--prompt', 'noop'], {
    env: installCheckEnv(home, { PATH: `${fake.dir}${delimiter}${process.env.PATH}` }),
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /not registered with any known coding-agent harness/);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.warnings.some((w) => /not registered with any known coding-agent harness/.test(w)));
});

test('codex-task stays quiet when the skill is registered or the check is disabled', () => {
  const fake = makeFakeCodex();

  const registeredHome = mkdtempSync(join(tmpdir(), 'codex-task-home-'));
  const skillDir = join(registeredHome, '.claude', 'skills', 'codex-task');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: codex-task\n---\n');
  const registered = runNode(['codex-task.mjs', '--prompt', 'noop'], {
    env: installCheckEnv(registeredHome, { PATH: `${fake.dir}${delimiter}${process.env.PATH}` }),
  });
  assert.equal(registered.status, 0);
  assert.equal(registered.stderr, '');
  assert.deepEqual(JSON.parse(registered.stdout).warnings, []);

  const bareHome = mkdtempSync(join(tmpdir(), 'codex-task-home-'));
  const flagged = runNode(['codex-task.mjs', '--prompt', 'noop', '--no-install-check'], {
    env: installCheckEnv(bareHome, { PATH: `${fake.dir}${delimiter}${process.env.PATH}` }),
  });
  assert.equal(flagged.status, 0);
  assert.equal(flagged.stderr, '');
  assert.deepEqual(JSON.parse(flagged.stdout).warnings, []);

  const envHome = mkdtempSync(join(tmpdir(), 'codex-task-home-'));
  const envSuppressed = runNode(['codex-task.mjs', '--prompt', 'noop'], {
    env: installCheckEnv(envHome, {
      PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
      CODEX_TASK_SKIP_INSTALL_CHECK: '1',
    }),
  });
  assert.equal(envSuppressed.status, 0);
  assert.equal(envSuppressed.stderr, '');
  assert.deepEqual(JSON.parse(envSuppressed.stdout).warnings, []);
});

test('codex-task treats installer-flag lookalikes in option values as task input', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', '--install'], {
    env: { ...baseEnv, PATH: `${fake.dir}${delimiter}${process.env.PATH}` },
  });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.taskResult, 'completed');
});

test('codex-task still emits JSON when the home directory cannot be resolved', () => {
  // On Windows, os.homedir() throws when HOME/USERPROFILE are empty; the
  // install check must swallow that and let the run proceed. On POSIX,
  // homedir() may still resolve via passwd — the run must succeed either way.
  const fake = makeFakeCodex();
  const env = { ...process.env, HOME: '', USERPROFILE: '', PATH: `${fake.dir}${delimiter}${process.env.PATH}` };
  delete env.CODEX_TASK_SKIP_INSTALL_CHECK;
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--quiet'], { env });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.taskResult, 'completed');
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
    "if (process.env.FAKE_CODEX_ARGV_OUT) {",
    '  writeFileSync(process.env.FAKE_CODEX_ARGV_OUT, JSON.stringify(args));',
    '}',
    "const i = args.indexOf('--output-last-message');",
    "if (i === -1 || !args[i + 1]) process.exit(2);",
    `writeFileSync(args[i + 1], ${JSON.stringify(resultJson)} + '\\n');`,
    '',
  ].join('\n');
}

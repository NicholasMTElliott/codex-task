import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// ---------- --retries (Trigger A) ----------

function retryEnv(fake, extra = {}) {
  return {
    ...baseEnv,
    PATH: `${fake.dir}${delimiter}${process.env.PATH}`,
    FAKE_CODEX_STATE: fake.statePath,
    CODEX_TASK_RETRY_DELAY_MS: '0',
    ...extra,
  };
}

function readCounter(fake) {
  return existsSync(fake.statePath) ? Number(readFileSync(fake.statePath, 'utf8')) : 0;
}

test('codex-task retries once on a transient model-capacity failure and succeeds', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '2'], {
    env: retryEnv(fake, {
      FAKE_CODEX_FAIL_TIMES: '1',
      FAKE_CODEX_FAIL_MESSAGE: 'Selected model is at capacity',
    }),
  });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.attempts, 2);
  assert.equal(parsed.warnings.filter((w) => /at capacity/i.test(w)).length, 1);
  assert.equal(readCounter(fake), 2);
});

test('codex-task classifies a banner-bearing capacity failure via the trailing line', () => {
  const fake = makeFakeCodex();
  const bannerMsg = [
    'reasoning effort: high',
    'session id: 11111111-2222-3333-4444-555555555555',
    'user: run the task',
    'Selected model is at capacity',
  ].join('\n');
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '2'], {
    env: retryEnv(fake, {
      FAKE_CODEX_FAIL_TIMES: '1',
      FAKE_CODEX_FAIL_MESSAGE: bannerMsg,
    }),
  });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.attempts, 2);
  const retryWarnings = parsed.warnings.filter((w) => /retrying/.test(w));
  assert.equal(retryWarnings.length, 1);
  assert.match(retryWarnings[0], /Selected model is at capacity/);
  assert.equal(readCounter(fake), 2);
});

test('codex-task retries when a durable-looking line is followed by a transient terminal line', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '2'], {
    env: retryEnv(fake, {
      FAKE_CODEX_FAIL_TIMES: '1',
      FAKE_CODEX_FAIL_MESSAGE: "You've hit your weekly usage limit\nSelected model is at capacity",
    }),
  });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.attempts, 2);
  assert.equal(readCounter(fake), 2);
});

test('codex-task does not retry when a transient-looking line is followed by a durable terminal line', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '2'], {
    env: retryEnv(fake, {
      FAKE_CODEX_FAIL_TIMES: '5',
      FAKE_CODEX_FAIL_MESSAGE: "Selected model is at capacity\nYou've hit your weekly usage limit",
    }),
  });

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.attempts, 1);
  assert.equal(readCounter(fake), 1);
});

test('codex-task retries a 429 rate-limit failure', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '1'], {
    env: retryEnv(fake, {
      FAKE_CODEX_FAIL_TIMES: '1',
      FAKE_CODEX_FAIL_MESSAGE: 'Error: 429 rate limit exceeded, please try again later',
    }),
  });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.attempts, 2);
  assert.ok(parsed.warnings.some((w) => /429|rate limit/i.test(w)));
  assert.equal(readCounter(fake), 2);
});

test('codex-task does not retry a generic "please try again" message with no transient signal', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '2'], {
    env: retryEnv(fake, {
      FAKE_CODEX_FAIL_TIMES: '5',
      FAKE_CODEX_FAIL_MESSAGE: 'Some permanent failure. Please try again',
    }),
  });

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.attempts, 1);
  assert.equal(readCounter(fake), 1);
});

test('codex-task does not retry an auth failure', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '2'], {
    env: retryEnv(fake, {
      FAKE_CODEX_FAIL_TIMES: '1',
      FAKE_CODEX_FAIL_MESSAGE: 'stream error: missing bearer token',
    }),
  });

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.attempts, 1);
  assert.equal(readCounter(fake), 1);
});

test('codex-task does not retry an unsupported-model failure', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '2'], {
    env: retryEnv(fake, {
      FAKE_CODEX_FAIL_TIMES: '5',
      FAKE_CODEX_FAIL_MESSAGE: 'model gpt-5.6-terra is not supported for this ChatGPT account',
    }),
  });

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.attempts, 1);
  assert.equal(readCounter(fake), 1);
});

test('codex-task does not retry an unsupported reasoning-effort failure', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '2'], {
    env: retryEnv(fake, {
      FAKE_CODEX_FAIL_TIMES: '5',
      FAKE_CODEX_FAIL_MESSAGE: "reasoning effort 'xhigh' is not supported for this model",
    }),
  });

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.attempts, 1);
  assert.equal(readCounter(fake), 1);
});

test('codex-task does not retry when a single line contains both transient and durable phrases', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '2'], {
    env: retryEnv(fake, {
      FAKE_CODEX_FAIL_TIMES: '5',
      FAKE_CODEX_FAIL_MESSAGE: "Selected model is at capacity. You've hit your weekly usage limit.",
    }),
  });

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.attempts, 1);
  assert.equal(readCounter(fake), 1);
});

test('codex-task exhausts retries on a persistent transient failure', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '2'], {
    env: retryEnv(fake, {
      FAKE_CODEX_FAIL_TIMES: '5',
      FAKE_CODEX_FAIL_MESSAGE: 'Selected model is at capacity',
    }),
  });

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.attempts, 3);
  assert.equal(parsed.warnings.filter((w) => /retrying/.test(w)).length, 2);
  assert.match(parsed.error, /at capacity/i);
  assert.equal(readCounter(fake), 3);
});

test('codex-task clears a stale final message left by a retried failed attempt', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '2'], {
    env: retryEnv(fake, {
      FAKE_CODEX_FAIL_TIMES: '1',
      FAKE_CODEX_FAIL_MESSAGE: 'Selected model is at capacity',
      FAKE_CODEX_FAIL_WRITES_FINAL: '1',
      FAKE_CODEX_NO_FINAL: '1',
    }),
  });

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.error, /did not write a final message/);
  assert.doesNotMatch(result.stdout, /STALE/);
  assert.equal(parsed.attempts, 2);
  assert.equal(readCounter(fake), 2);
});

test('codex-task retries a non-zero-exit sandbox-wrapper prep failure', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '1'], {
    env: retryEnv(fake, {
      FAKE_CODEX_FAIL_TIMES: '1',
      FAKE_CODEX_FAIL_MESSAGE: 'windows unelevated restricted-token sandbox cannot enforce split writable root sets directly; refusing to run unsandboxed',
    }),
  });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.attempts, 2);
  assert.equal(readCounter(fake), 2);
});

test('codex-task does not retry an exit-0 malformed final-message JSON', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '2'], {
    env: retryEnv(fake, { FAKE_CODEX_BAD_FINAL: '1' }),
  });

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.error, /not valid JSON|no extractable JSON/);
  assert.equal(parsed.attempts, 1);
  assert.equal(readCounter(fake), 1);
});

test('codex-task does not retry an exit-0 missing final-message file', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '2'], {
    env: retryEnv(fake, { FAKE_CODEX_NO_FINAL: '1' }),
  });

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.error, /did not write a final message/);
  assert.equal(parsed.attempts, 1);
  assert.equal(readCounter(fake), 1);
});

test('codex-task reports attempts:0 when the codex preflight check fails with retries set', () => {
  const fake = makeFakeCodex();
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '2'], {
    env: retryEnv(fake, { FAKE_CODEX_FAIL_VERSION: '1' }),
  });

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.error, /codex CLI was not found on PATH|failed to run "codex --version"/);
  assert.equal(parsed.attempts, 0);
  assert.equal(readCounter(fake), 0);
});

test('codex-task --retries 0 (or omitted) is structurally identical to today on success and failure paths', () => {
  // (a) clean-success path
  {
    const fakeOmit = makeFakeCodex();
    const omitted = runNode(['codex-task.mjs', '--prompt', 'noop'], {
      env: retryEnv(fakeOmit),
    });
    const fakeZero = makeFakeCodex();
    const zero = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '0'], {
      env: retryEnv(fakeZero),
    });

    assert.equal(omitted.status, 0);
    assert.equal(zero.status, 0);
    const omittedParsed = JSON.parse(omitted.stdout);
    const zeroParsed = JSON.parse(zero.stdout);
    assert.ok(!('attempts' in omittedParsed));
    assert.ok(!('attempts' in zeroParsed));
    assert.ok(!omittedParsed.warnings.some((w) => /attempt|retry/i.test(w)));
    assert.ok(!zeroParsed.warnings.some((w) => /attempt|retry/i.test(w)));
    delete omittedParsed.durationMs; delete omittedParsed.sessionDir;
    delete zeroParsed.durationMs; delete zeroParsed.sessionDir;
    assert.deepEqual(zeroParsed, omittedParsed);
  }

  // (b) fixed-diagnostic failure path (durable-shaped: never retried regardless of --retries)
  {
    const fakeOmit = makeFakeCodex();
    const omitted = runNode(['codex-task.mjs', '--prompt', 'noop'], {
      env: retryEnv(fakeOmit, { FAKE_CODEX_FAIL_TIMES: '99', FAKE_CODEX_FAIL_MESSAGE: 'Selected model is at capacity' }),
    });
    const fakeZero = makeFakeCodex();
    const zero = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '0'], {
      env: retryEnv(fakeZero, { FAKE_CODEX_FAIL_TIMES: '99', FAKE_CODEX_FAIL_MESSAGE: 'Selected model is at capacity' }),
    });

    assert.equal(omitted.status, 1);
    assert.equal(zero.status, 1);
    const omittedParsed = JSON.parse(omitted.stdout);
    const zeroParsed = JSON.parse(zero.stdout);
    assert.ok(!('attempts' in omittedParsed));
    assert.ok(!('attempts' in zeroParsed));
    assert.ok(!omittedParsed.warnings.some((w) => /attempt|retry/i.test(w)));
    assert.ok(!zeroParsed.warnings.some((w) => /attempt|retry/i.test(w)));
    delete omittedParsed.durationMs; delete omittedParsed.sessionDir;
    delete zeroParsed.durationMs; delete zeroParsed.sessionDir;
    assert.deepEqual(zeroParsed, omittedParsed);
  }
});

test('codex-task --help documents --retries', () => {
  const result = runNode(['codex-task.mjs', '--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--retries/);
});

test('codex-task rejects an invalid --retries value', () => {
  const neg = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '-1']);
  assert.equal(neg.status, 2);
  assert.match(neg.stderr, /--retries must be a non-negative integer/);

  const nan = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', 'abc']);
  assert.equal(nan.status, 2);
  assert.match(nan.stderr, /--retries must be a non-negative integer/);
});

test('codex-task does not misread --retries\' value token as an installer flag', () => {
  // --retries is value-taking; the installer-dispatch pre-scan must skip its
  // value the same way it skips --model's, --cwd's, etc. Before the fix,
  // "--retries --uninstall" (an invalid --retries value that happens to spell
  // a real installer flag) was misread as installer mode BEFORE arg
  // validation ran, forwarding straight to install.mjs --uninstall.
  const result = runNode(['codex-task.mjs', '--prompt', 'noop', '--retries', '--uninstall']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--retries must be a non-negative integer/);
  assert.doesNotMatch(result.stdout, /uninstall/i);
});

function makeFakeCodex() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-task-test-'));
  const statePath = join(dir, 'state.txt');
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
  return { dir, statePath };
}

// fake-codex.mjs supports env-driven, on-disk modes (state on disk because
// each `codex exec` invocation is a fresh process):
//   FAKE_CODEX_STATE            path to a counter file; every non-`--version`
//                                invocation reads, increments, writes it.
//   FAKE_CODEX_FAIL_TIMES       leading invocations (by counter) that fail
//                                non-zero (default 0 = never fail).
//   FAKE_CODEX_FAIL_MESSAGE     stderr text on a failing invocation (may be
//                                multi-line).
//   FAKE_CODEX_FAIL_WRITES_FINAL on a FAILING invocation, also write a
//                                valid-JSON STALE sentinel to the
//                                --output-last-message path before exit 1.
//   FAKE_CODEX_BAD_FINAL        on SUCCESS, write non-JSON garbage, exit 0.
//   FAKE_CODEX_NO_FINAL         on SUCCESS, write no final-message file, exit 0.
//   FAKE_CODEX_FAIL_VERSION     make the --version branch exit non-zero.
function fakeCodexJs(resultJson) {
  return [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    "if (args[0] === '--version') {",
    '  if (process.env.FAKE_CODEX_FAIL_VERSION) {',
    "    console.error('fake codex --version failed');",
    '    process.exit(1);',
    '  }',
    "  console.log('codex-test 0.0.0');",
    '  process.exit(0);',
    '}',
    '',
    'let count = 0;',
    'if (process.env.FAKE_CODEX_STATE) {',
    '  const statePath = process.env.FAKE_CODEX_STATE;',
    "  count = existsSync(statePath) ? (Number(readFileSync(statePath, 'utf8')) || 0) : 0;",
    '  count += 1;',
    '  writeFileSync(statePath, String(count));',
    '}',
    '',
    "console.log('FAKE_STDOUT');",
    "console.error('FAKE_STDERR');",
    'if (process.env.FAKE_CODEX_ARGV_OUT) {',
    '  writeFileSync(process.env.FAKE_CODEX_ARGV_OUT, JSON.stringify(args));',
    '}',
    '',
    "const i = args.indexOf('--output-last-message');",
    'const outPath = i === -1 ? null : args[i + 1];',
    '',
    "const failTimes = Number(process.env.FAKE_CODEX_FAIL_TIMES || '0');",
    'if (failTimes > 0 && count <= failTimes) {',
    '  if (process.env.FAKE_CODEX_FAIL_WRITES_FINAL && outPath) {',
    '    writeFileSync(outPath, JSON.stringify({ taskResult: \'completed\', summary: \'STALE\' }) + \'\\n\');',
    '  }',
    "  const msg = process.env.FAKE_CODEX_FAIL_MESSAGE || 'fake codex failure';",
    '  console.error(msg);',
    '  process.exit(1);',
    '}',
    '',
    'if (!outPath) process.exit(2);',
    'if (process.env.FAKE_CODEX_BAD_FINAL) {',
    "  writeFileSync(outPath, 'not json garbage');",
    '  process.exit(0);',
    '}',
    'if (process.env.FAKE_CODEX_NO_FINAL) {',
    '  process.exit(0);',
    '}',
    `writeFileSync(outPath, ${JSON.stringify(resultJson)} + '\\n');`,
    '',
  ].join('\n');
}

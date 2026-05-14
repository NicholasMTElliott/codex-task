import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function runNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('codex-task help documents the JSON contract and permission modes', () => {
  const result = runNode(['codex-task.mjs', '--help']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--permissions read-only\|workspace-write\|full-auto\|danger-full-access/);
  assert.match(result.stdout, /Output: JSON on stdout/);
});

test('installer lists all supported harness targets without requiring codex', () => {
  const result = runNode(['install.mjs', '--list-targets']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  for (const target of ['claude', 'opencode', 'cline', 'cursor', 'agents']) {
    assert.match(result.stdout, new RegExp(`\\b${target}\\b`));
  }
});

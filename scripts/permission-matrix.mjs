#!/usr/bin/env node
/**
 * Manual permission matrix for codex-task.
 *
 * This is intentionally NOT wired into npm test. It spends Codex quota and
 * includes a danger-full-access case that writes outside the target project.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultTarget = resolve(repoRoot, '..', 'kva');
const permissions = ['read-only', 'workspace-write', 'danger-full-access'];
const taskIds = ['read-features', 'write-workspace-features', 'write-parent-features'];
const expectations = {
  'read-only': {
    'read-features': true,
    'write-workspace-features': false,
    'write-parent-features': false,
  },
  'workspace-write': {
    'read-features': true,
    'write-workspace-features': true,
    'write-parent-features': false,
  },
  'danger-full-access': {
    'read-features': true,
    'write-workspace-features': true,
    'write-parent-features': true,
  },
};

function parseArgs(argv) {
  const out = {
    target: defaultTarget,
    model: '',
    onlyPermission: '',
    onlyTask: '',
    keepFiles: false,
    quiet: false,
    streamThinking: false,
    yes: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--target') { out.target = next ?? ''; i++; }
    else if (arg.startsWith('--target=')) out.target = arg.slice('--target='.length);
    else if (arg === '--model') { out.model = next ?? ''; i++; }
    else if (arg.startsWith('--model=')) out.model = arg.slice('--model='.length);
    else if (arg === '--permission') { out.onlyPermission = next ?? ''; i++; }
    else if (arg.startsWith('--permission=')) out.onlyPermission = arg.slice('--permission='.length);
    else if (arg === '--task') { out.onlyTask = next ?? ''; i++; }
    else if (arg.startsWith('--task=')) out.onlyTask = arg.slice('--task='.length);
    else if (arg === '--keep-files') out.keepFiles = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--stream-thinking') out.streamThinking = true;
    else if (arg === '--yes') out.yes = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else fail(`unknown argument: ${arg}`);
  }

  if (!out.target) fail('--target requires a value');
  if (out.onlyPermission && !permissions.includes(out.onlyPermission)) {
    fail(`--permission must be one of: ${permissions.join(', ')}`);
  }
  if (out.onlyTask && !taskIds.includes(out.onlyTask)) {
    fail(`--task must be one of: ${taskIds.join(', ')}`);
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/permission-matrix.mjs --yes [--target DIR]
  node scripts/permission-matrix.mjs --yes --target ..\\kva

Runs a manual 3x3 Codex sandbox matrix against a local project.
Default target: ${defaultTarget}

Options:
  --target DIR          Project directory for codex-task --cwd.
  --model MODEL         Optional codex model pass-through.
  --permission MODE     Run one permission only: ${permissions.join('|')}.
  --task TASK           Run one task only: ${taskIds.join('|')}.
  --quiet               Suppress harness echo of codex-task stderr.
  --stream-thinking     Pass --stream-thinking to codex-task.
  --keep-files          Leave successful probe files in place.
  --yes                 Required. Acknowledges Codex quota and file writes.

Expected matrix:
  read-only:          read-features works; workspace/parent writes fail.
  workspace-write:    read + workspace write work; parent write fails.
  danger-full-access: all three work.
`);
}

function fail(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(2);
}

function makeRunId() {
  return `codex-task-permission-matrix-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
}

function taskDefinitions(targetDir, runId) {
  const workspaceFile = join(targetDir, `FEATURES.${runId}.md`);
  const parentFile = join(dirname(targetDir), `FEATURES.${runId}.md`);
  const readPrompt = [
    'Read this project and return a bullet-point list of its user-facing features.',
    'Do not modify, create, or delete any files.',
  ].join('\n');
  const workspacePrompt = [
    'Read this project and write a bullet-point list of its user-facing features',
    `to this exact file inside the project workspace: ${workspaceFile}`,
    'Overwrite that file if it already exists.',
    'Your final JSON summary should mention whether the file write succeeded.',
  ].join('\n');
  const parentPrompt = [
    'Read this project and write a bullet-point list of its user-facing features',
    `to this exact file outside the project workspace: ${parentFile}`,
    'Overwrite that file if it already exists.',
    'Your final JSON summary should mention whether the file write succeeded.',
  ].join('\n');

  return {
    'read-features': {
      prompt: readPrompt,
      expectedFile: '',
      forbiddenFile: '',
    },
    'write-workspace-features': {
      prompt: workspacePrompt,
      expectedFile: workspaceFile,
      forbiddenFile: '',
    },
    'write-parent-features': {
      prompt: parentPrompt,
      expectedFile: parentFile,
      forbiddenFile: '',
    },
  };
}

function runCodexTask({ targetDir, model, permission, prompt, quiet, streamThinking }) {
  return new Promise((resolveP, rejectP) => {
    const args = [
      join(repoRoot, 'codex-task.mjs'),
      '--cwd', targetDir,
      '--permissions', permission,
      '--prompt', prompt,
    ];
    if (model) args.push('--model', model);
    if (quiet) args.push('--quiet');
    if (streamThinking) args.push('--stream-thinking');

    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      if (!quiet) process.stderr.write(text);
    });
    child.on('error', rejectP);
    child.on('close', (code) => {
      resolveP({
        code: code ?? -1,
        stdout,
        stderr,
        result: parseJson(stdout),
      });
    });
  });
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function fileHasContent(path) {
  if (!path || !existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

function safeRemove(path) {
  if (!path || !existsSync(path)) return;
  rmSync(path, { force: true });
}

function evaluateRun({ expectedOk, task, run, fileWritten }) {
  const taskResult = run.result?.taskResult ?? null;
  const wrapperCompleted = run.code === 0
    && run.result?.ok === true
    && taskResult === 'completed';

  if (expectedOk) {
    const ok = task.expectedFile ? (wrapperCompleted && fileWritten) : wrapperCompleted;
    return {
      ok,
      passed: ok,
      reason: ok ? 'completed as expected' : `expected completion, got exit=${run.code} ok=${run.result?.ok ?? null} taskResult=${taskResult} fileWritten=${fileWritten}`,
    };
  }

  const blocked = run.code !== 0
    && run.result?.ok === false
    && ['blocked', 'failed'].includes(taskResult)
    && !fileWritten;
  return {
    ok: false,
    passed: blocked,
    reason: blocked ? 'blocked as expected' : `expected blocked failure, got exit=${run.code} ok=${run.result?.ok ?? null} taskResult=${taskResult} fileWritten=${fileWritten}`,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.yes) {
    printHelp();
    fail('pass --yes to run this manual matrix');
  }

  const targetDir = isAbsolute(args.target) ? args.target : resolve(process.cwd(), args.target);
  if (!existsSync(targetDir)) fail(`target directory does not exist: ${targetDir}`);

  const runId = makeRunId();
  const tasks = taskDefinitions(targetDir, runId);
  const selectedPermissions = args.onlyPermission ? [args.onlyPermission] : permissions;
  const selectedTasks = args.onlyTask ? [args.onlyTask] : taskIds;
  const artifactDir = join(repoRoot, 'tmp', 'permission-matrix');
  mkdirSync(artifactDir, { recursive: true });

  const rows = [];
  process.stdout.write(`Permission matrix target: ${targetDir}\n`);
  process.stdout.write(`Run id: ${runId}\n\n`);

  for (const permission of selectedPermissions) {
    for (const taskId of selectedTasks) {
      const task = tasks[taskId];
      safeRemove(task.expectedFile);

      process.stdout.write(`[run] ${permission} / ${taskId}\n`);
      const run = await runCodexTask({
        targetDir,
        model: args.model,
        permission,
        prompt: task.prompt,
        quiet: args.quiet,
        streamThinking: args.streamThinking,
      });

      const expectedOk = expectations[permission][taskId];
      const fileWritten = fileHasContent(task.expectedFile);
      const actual = evaluateRun({ expectedOk, task, run, fileWritten });
      const row = {
        permission,
        task: taskId,
        expectedOk,
        actualOk: actual.ok,
        passed: actual.passed,
        exitCode: run.code,
        wrapperOk: run.result?.ok ?? null,
        taskResult: run.result?.taskResult ?? null,
        outputFile: task.expectedFile || null,
        error: run.result?.error ?? null,
      };
      rows.push(row);
      writeFileSync(
        join(artifactDir, `${permission}.${taskId}.${runId}.json`),
        JSON.stringify({ row, stdout: run.stdout, stderr: run.stderr }, null, 2) + '\n',
      );

      process.stdout.write(`[${actual.passed ? 'pass' : 'fail'}] expected ${expectedOk ? 'work' : 'fail'}, observed ${actual.ok ? 'work' : 'fail'} (${actual.reason})\n\n`);
      if (!args.keepFiles && expectedOk && task.expectedFile) safeRemove(task.expectedFile);
    }
  }

  const failed = rows.filter((r) => !r.passed);
  process.stdout.write('Summary:\n');
  for (const row of rows) {
    process.stdout.write(`  ${row.passed ? 'PASS' : 'FAIL'}  ${row.permission.padEnd(18)} ${row.task.padEnd(25)} expected=${row.expectedOk} actual=${row.actualOk} taskResult=${row.taskResult}\n`);
  }
  process.stdout.write(`\nArtifacts: ${artifactDir}\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});

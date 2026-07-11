#!/usr/bin/env node
/**
 * codex-task
 *
 * Invoke OpenAI's codex CLI to perform an arbitrary agent task against the
 * user's project, returning a structured JSON result describing the work.
 * Uses the user's ChatGPT subscription billing (NOT API tokens).
 *
 * Usage:
 *   node codex-task.mjs --prompt "Refactor logger.js to use pino"
 *   node codex-task.mjs --prompt-file brief.md --cwd path/to/project
 *
 * Output: JSON on stdout with shape:
 *   {
 *     "ok": true,
 *     "taskResult": "completed",
 *     "summary": "...",
 *     "details": "...",
 *     "files": { "<path>": "<created|deleted|edited>", ... },
 *     "workdir":   "<absolute path codex was --cd'd to>",
 *     "sessionDir":"<absolute OS-tmp session dir, removed on success>",
 *     "model":     "<model used>",
 *     "permissions": "<sandbox mode used>",
 *     "warnings": [],
 *     "durationMs": 12345
 *   }
 *
 * Codex's own log output is captured silently by default. Pass
 * --stream-thinking to mirror it live to stderr. Structured stdout is the
 * JSON only (always last, always valid).
 *
 * Subscription billing requires OPENAI_API_KEY to be UNSET in the spawned env
 * — if present, codex silently switches to API token billing. We deliberately
 * do NOT override CODEX_HOME: codex stores its ChatGPT auth there, and
 * overriding it forces a fresh-install state that drops the user's login.
 * (codex#11435 parallel-session corruption is only a problem under concurrent
 * invocations; this tool is serial-by-design.)
 *
 * No npm dependencies. Requires Node 18+ and `codex` CLI on PATH.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Silence DEP0190 (spawn shell:true with args). shell:true is required on
// Windows because post-CVE-2024-27980 Node refuses to spawn .cmd shims any
// other way, and codex installs as codex.cmd via npm.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.code === 'DEP0190') return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

// Allowed action verbs in the result.files map. Anything else gets demoted
// to "referenced" with a warning; we never reject the run for a stray verb.
const ALLOWED_ACTIONS = new Set(['created', 'deleted', 'edited', 'referenced']);
const ALLOWED_TASK_RESULTS = new Set(['completed', 'partial', 'blocked', 'failed']);

// Default model. The set of supported models is plan-dependent and not
// enumerable from the CLI — codex validates server-side and returns 400 for
// unsupported values. Common known names at time of writing: gpt-5.5,
// gpt-5.5-codex, gpt-5, gpt-5-codex, and the GPT-5.6 tiers (gpt-5.6-sol,
// gpt-5.6-terra, gpt-5.6-luna). Surface these in --help for hints.
const DEFAULT_MODEL = 'gpt-5.5';
const KNOWN_MODEL_HINTS = [
  'gpt-5.5', 'gpt-5.5-codex', 'gpt-5', 'gpt-5-codex',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
];

// --permissions values map directly to codex's supported --sandbox values.
const PERMISSIONS = {
  'read-only':           { sandbox: 'read-only' },
  'workspace-write':     { sandbox: 'workspace-write' },
  'danger-full-access':  { sandbox: 'danger-full-access' },
};
const DEFAULT_PERMISSIONS = 'read-only';

// ---------- installer dispatch ----------

// When any of these flags is present, the invocation is forwarded to
// install.mjs, which lives next to this script in a repo checkout, in the
// npm package dir, and (because the installer copies itself) in ~/.codex-task/.
// This is what makes `codex-task --install` work after `npm install -g`.
const INSTALLER_FLAGS = new Set(['--install', '--uninstall', '--list-targets']);

// Task flags whose next argv token is a value, not a flag. Mirrors parseArgs.
// The dispatch scan skips these values so a task like --prompt "--install"
// is never misread as installer mode.
const VALUE_TAKING_FLAGS = new Set([
  '--prompt', '--prompt-file', '--cwd', '--out',
  '--model', '--permissions', '--profile', '--reasoning-effort', '--retries',
]);

function hasInstallerFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_TAKING_FLAGS.has(argv[i])) { i++; continue; }
    if (INSTALLER_FLAGS.has(argv[i])) return true;
  }
  return false;
}

function maybeRunInstaller(argv) {
  if (!hasInstallerFlag(argv)) return;
  const installerPath = join(dirname(fileURLToPath(import.meta.url)), 'install.mjs');
  if (!existsSync(installerPath)) {
    process.stderr.write(
      `error: installer not found at ${installerPath}\n`
      + `install.mjs must live next to codex-task.mjs (repo checkout, npm package dir, or an install dir written by a current installer).\n`,
    );
    process.exit(1);
  }
  // install.mjs owns --uninstall/--list-targets/--target=/--all/--no-<id>;
  // strip only the flags that are ours.
  const forwarded = argv.filter((a) => a !== '--install' && a !== '--no-install-check');
  const r = spawnSync(process.execPath, [installerPath, ...forwarded], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`error: failed to run installer: ${r.error.message}\n`);
    process.exit(1);
  }
  if (r.signal) {
    process.stderr.write(`error: installer terminated by signal ${r.signal}\n`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

// Skill locations probed by the not-installed warning. Keep in sync with the
// TARGETS registry in install.mjs — drift here only degrades the warning's
// accuracy, never the correctness of a run.
function skillProbePaths() {
  const home = homedir();
  return [
    join(home, '.claude', 'skills', 'codex-task', 'SKILL.md'),
    join(home, '.config', 'opencode', 'skills', 'codex-task', 'SKILL.md'),
    join(home, '.cline', 'skills', 'codex-task', 'SKILL.md'),
    join(home, '.cursor', 'skills', 'codex-task', 'SKILL.md'),
    join(home, '.agents', 'skills', 'codex-task', 'SKILL.md'),
  ];
}

// ---------- retry classification (Trigger A: non-zero-exit only) ----------

// Short fixed backoff between retried attempts. Overridable via env so tests
// never sleep for real.
const RETRY_BACKOFF_MS = process.env.CODEX_TASK_RETRY_DELAY_MS !== undefined
  ? Number(process.env.CODEX_TASK_RETRY_DELAY_MS)
  : 2000;

// codex terminal errors are 1-2 lines; 3 is headroom.
const MAX_TAIL_SCAN = 3;

// Durable failures — retry cannot help. Tested first on each scanned line.
const NON_TRANSIENT_PATTERNS = [
  // auth / login expiry
  /missing bearer|unauthoriz(?:ed|ation)|authentication|\b401\b|codex login|not logged in|invalid api key/i,
  // unsupported model
  /model .*not supported|not supported.*ChatGPT account|unsupported model|\b400\b/i,
  // unsupported / rejected reasoning effort — anchored to explicit REJECTION
  // grammar so a banner echo like "reasoning effort: high" can never match.
  /(?:reasoning[ _]?effort|model_reasoning_effort)[^.\n]{0,40}(?:not supported|unsupported|invalid|not a valid)|(?:unsupported|invalid)(?: value(?: for)?)?[^.\n]{0,40}(?:reasoning[ _]?effort|model_reasoning_effort)/i,
  // durable quota / usage-cap exhaustion — CONTEXTUAL phrases only. Deliberately
  // NO bare "limit exceeded" and NO bare "rate limit" here, so transient
  // "429 rate limit exceeded" is NOT swallowed by this phase.
  /usage limit|weekly limit|monthly limit|usage cap|plan limit|\bquota\b|(?:hit|reached|exceeded) your[^.\n]*\blimit\b/i,
];

// Isolated sandbox-wrapper PREP failures — retry can help. Used by the Trigger A
// transient classifier. Intentionally NARROW: wrapper-prep phrases only, NOT the
// broad sandbox branch in codexFailureHint. A generic permission / read-only
// denial is a config problem, not transient, so it is NOT retried.
const SANDBOX_WRAPPER_PATTERNS = [
  /failed to prepare\b[^\n]*sandbox wrapper/i,
  /cannot enforce split writable root sets/i,
  /refusing to run unsandboxed/i,
  /restricted-token sandbox/i,
];

// Transient infrastructure for Trigger A — retry can help. First label wins.
const TRANSIENT_PATTERNS = [
  { label: 'model-capacity',
    // Bare "please try again" / "try again later" REMOVED: a real capacity /
    // rate / temporary signal must be present on the line itself.
    re: /\bat capacity\b|\b429\b|rate[ _-]?limit|too many requests|temporarily unavailable|server (?:is )?overloaded/i },
  { label: 'sandbox-wrapper',
    re: new RegExp(SANDBOX_WRAPPER_PATTERNS.map((r) => r.source).join('|'), 'i') },
];

// Scan the last few non-blank lines from the END. The first line (closest to
// the end) that matches a durable OR transient pattern decides the whole tail.
// A line matching neither is skipped. Durable wins over transient WITHIN a line.
// No banner grammar: we never try to recognize or strip banner/config text.
function classifyFailure(tail) {
  const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const window = lines.slice(-MAX_TAIL_SCAN); // last N non-blank lines
  for (let i = window.length - 1; i >= 0; i--) { // scan from the END backward
    const line = window[i];
    if (NON_TRANSIENT_PATTERNS.some((re) => re.test(line))) {
      return { label: null, line }; // durable classified line wins -> no retry
    }
    for (const { label, re } of TRANSIENT_PATTERNS) {
      if (re.test(line)) return { label, line }; // transient classified line wins
    }
    // line matched nothing -> keep scanning the earlier line
  }
  return { label: null, line: window[window.length - 1] ?? '' };
}

// Same tail derivation formatCodexRunFailure uses — the classification input.
// error still reports the full raw tail via formatCodexRunFailure.
function tailOf(runResult) {
  return (runResult.stderrTail || runResult.stdoutTail || '').trim();
}

function sleep(ms) {
  return new Promise((resolveP) => setTimeout(resolveP, ms));
}

// ---------- arg parsing ----------

function parseArgs(argv) {
  let prompt = '';
  let promptFile = '';
  let cwd = '';
  let out = '';
  let debug = false;
  let quiet = false;
  let streamThinking = false;
  let trackReferences = false;
  let model = DEFAULT_MODEL;
  let permissions = DEFAULT_PERMISSIONS;
  let profile = '';
  let reasoningEffort = null; // null = flag absent; string = resolved level
  let noInstallCheck = false;
  let retries = 0;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--prompt') { prompt = next ?? ''; i++; }
    else if (arg === '--prompt-file') { promptFile = next ?? ''; i++; }
    else if (arg === '--cwd') { cwd = next ?? ''; i++; }
    else if (arg === '--out') { out = next ?? ''; i++; }
    else if (arg === '--debug') { debug = true; }
    else if (arg === '--quiet') { quiet = true; }
    else if (arg === '--stream-thinking') { streamThinking = true; }
    else if (arg === '--track-references') { trackReferences = true; }
    else if (arg === '--no-install-check') { noInstallCheck = true; }
    else if (arg === '--model') { model = next ?? ''; i++; }
    else if (arg === '--permissions') { permissions = (next ?? '').toLowerCase(); i++; }
    else if (arg === '--profile') { profile = next ?? ''; i++; }
    else if (arg === '--reasoning-effort') {
      if (next === undefined || next === '') usageErr('--reasoning-effort requires a value');
      reasoningEffort = next; i++;
    }
    else if (arg === '--retries') {
      if (next === undefined || !/^-?\d+$/.test(next) || Number(next) < 0) {
        usageErr('--retries must be a non-negative integer');
      }
      retries = Number(next); i++;
    }
    else if (arg === '-h' || arg === '--help') { printUsage(process.stdout); process.exit(0); }
    else { usageErr(`unknown argument "${arg}"`); }
  }

  if (prompt && promptFile) usageErr('--prompt and --prompt-file are mutually exclusive');
  if (promptFile) prompt = readPromptFile(promptFile, '--prompt-file');
  if (!prompt) { printUsage(process.stderr); process.exit(2); }

  if (!model) usageErr('--model requires a value');
  if (!Object.prototype.hasOwnProperty.call(PERMISSIONS, permissions)) {
    const allowed = Object.keys(PERMISSIONS).join(', ');
    usageErr(`--permissions must be one of: ${allowed} (got "${permissions}")`);
  }

  return { prompt, cwd, out, debug, quiet, streamThinking, trackReferences, model, permissions, profile, reasoningEffort, noInstallCheck, retries };
}

function usageErr(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}

function readPromptFile(path, flag) {
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (e) {
    process.stderr.write(`error: failed to read ${flag} ${path}: ${e.message}\n`);
    process.exit(2);
  }
  const trimmed = contents.trim();
  if (!trimmed) {
    process.stderr.write(`error: ${flag} ${path} is empty\n`);
    process.exit(2);
  }
  return trimmed;
}

function printUsage(stream = process.stderr) {
  const perms = Object.keys(PERMISSIONS).join('|');
  stream.write(
    `Usage:
  node codex-task.mjs (--prompt "<text>" | --prompt-file <path>)
                      [--cwd DIR] [--out FILE] [--debug] [--quiet]
                      [--stream-thinking] [--track-references]
                      [--no-install-check] [--retries N]
                      [--model MODEL] [--reasoning-effort LEVEL]
                      [--permissions ${perms}]
                      [--profile NAME]

Installer mode (forwards to install.mjs; see its --help for details):
  node codex-task.mjs --install [--target=<csv>] [--all] [--no-<id>]
  node codex-task.mjs --uninstall
  node codex-task.mjs --list-targets

Wrap a single 'codex exec' invocation, run an arbitrary agent task, and
capture a structured JSON result describing what files were touched.

Required:
  --prompt       Inline task description. Anything you'd tell codex to do.
  --prompt-file  Read the task description from a UTF-8 text file. Mutually
                 exclusive with --prompt. Trailing whitespace is trimmed;
                 internal newlines are preserved.

Workspace:
  --cwd          Working directory codex operates inside (relative to caller
                 cwd, or absolute). Default: caller cwd. Codex's sandbox is
                 bounded by this directory unless danger-full-access is used.

Codex pass-throughs:
  --model        Model codex should use. Default: ${DEFAULT_MODEL}.
                 Supported models are plan-dependent; codex validates
                 server-side and returns an error for unsupported values.
                 Common known values (your plan may vary):
                   ${KNOWN_MODEL_HINTS.join(', ')}
  --reasoning-effort
                 Reasoning effort level, passed through to codex as
                 -c model_reasoning_effort="<level>". Unset by default (no
                 override). Plan- and model-dependent; codex validates
                 server-side. Commonly-seen levels (hints only, not a
                 validated enum): minimal|low|medium|high|xhigh, plus
                 max|ultra on some model tiers.
  --permissions  Sandbox policy for codex. Default: ${DEFAULT_PERMISSIONS}.
                 Maps to codex's --sandbox flag (approval is always 'never'
                 since 'codex exec' defaults approval to never):
                   read-only          codex can read your workspace but
                                      cannot modify or create any files
                                      in it. Best for investigation,
                                      audits, codebase questions.
                   workspace-write    codex can read AND write inside the
                                      working directory (--cwd). Files
                                      outside the workdir remain read-only.
                                      Use for refactors and edits.
                   danger-full-access codex can read AND write anywhere
                                      on the filesystem. Use only when you
                                      explicitly need cross-tree writes
                                      AND understand the blast radius.
                 The structured result is captured via codex's
                 --output-last-message flag (a codex-process write, not a
                 model write), so it works under any --sandbox mode
                 including 'read-only'.
  --profile      Codex config profile name (--profile pass-through). If
                 set, codex loads option defaults from this profile in
                 ~/.codex/config.toml. Unset by default.

Wrapper options:
  --out          Also write the result JSON to this file path (still
                 printed to stdout). Useful for piping or persisting.
  --debug        Keep the per-session scratch dir on success. Default
                 cleans it up. Failures always preserve it regardless.
  --quiet        Suppress live mirroring to stderr. Retained for
                 compatibility; live streaming is already disabled by default.
  --stream-thinking
                 Mirror codex's live stdout/stderr to this wrapper's stderr.
                 By default, codex chatter is captured only for diagnostic
                 tails and is not streamed.
  --track-references
                 Include "referenced" entries in the files map. By default,
                 referenced-only files are omitted so the JSON stays small.
  --no-install-check
                 Skip the startup check that warns (on stderr and in the
                 result's "warnings" array) when the codex-task skill is not
                 registered with any known coding-agent harness. Also
                 skippable via CODEX_TASK_SKIP_INSTALL_CHECK=1.
  --retries      Number of retries (non-negative integer) on a codex exec
                 failure whose diagnostic tail classifies as a transient
                 infrastructure error: model-capacity (e.g. "at capacity",
                 429/rate-limit/temporarily-unavailable/overloaded) or a
                 sandbox-wrapper prep failure. Default 0 (no retry; omitting
                 the flag is byte-identical to today). NOT retried: auth,
                 unsupported model/effort, durable quota/usage-cap limits,
                 generic "please try again" text, JSON/contract failures, and
                 every clean (exit-0) result regardless of taskResult
                 (including "blocked"). Retries are sequential, with a short
                 fixed backoff (overridable via CODEX_TASK_RETRY_DELAY_MS for
                 tests). When set > 0, the result JSON gains an "attempts"
                 field (count of codex exec invocations) and one warning per
                 retried failure.

Output: JSON on stdout. Shape:

  {
    "ok": true,
    "taskResult": "completed",
    "summary":     "<one or two sentences>",
    "details":     "<markdown>",
    "files":       { "<path>": "<created|deleted|edited>", ... },
    "workdir":     "<absolute --cwd>",
    "sessionDir":  null,
    "model":       "<model used>",
    "permissions": "<permissions mode used>",
    "reasoningEffort": null,
    "warnings":    [],
    "durationMs":  12345
  }

The per-session scratch dir lives under your OS temp directory (NOT inside
the workdir, so the user's project is never polluted with a wrapper-owned
folder). It is removed automatically on success unless --debug is set;
failures preserve it for debugging — the path appears in 'sessionDir'.

Subscription billing: OPENAI_API_KEY is stripped from the spawned env so
codex routes to ChatGPT subscription quota, not API tokens. Each run is
spawned with --ephemeral, so this wrapper never adds to codex's persisted
session history — each task is a clean slate.
`,
  );
}

// ---------- prompt synthesis ----------

function buildPrompt(userPrompt, { permissions, trackReferences }) {
  const readOnly = permissions === 'read-only';
  const lines = [
    `You are being invoked through a wrapper that captures a structured result.`,
    ``,
    `TASK:`,
    userPrompt,
    ``,
  ];
  if (readOnly) {
    lines.push(
      `IMPORTANT: This task runs under a READ-ONLY sandbox. You can read any`,
      `file under the working directory, but you CANNOT modify, create, or`,
      `delete files there. If the task asks you to modify files, instead`,
      `describe in 'details' exactly what edits would be needed (with file`,
      `paths and snippets). Set "taskResult" to "blocked" when a requested`,
      `write/create/delete could not be completed because of the sandbox.`,
      ``,
    );
  }
  lines.push(
    `When you have completed the task, your FINAL message must be a single`,
    `JSON object with this exact shape — no prose before or after, no markdown`,
    `fences, no commentary:`,
    ``,
    `{`,
    `  "taskResult": "<completed|partial|blocked|failed>",`,
    `  "summary": "<one or two sentence high-level description of what you did>",`,
    `  "details": "<longer markdown explanation including reasoning, caveats, and any follow-ups the caller should know about>",`,
    `  "files": {`,
    `    "<repo-relative path>": "<created|deleted|edited|referenced>"`,
    `  }`,
    `}`,
    ``,
    `For each file you touched, classify it as exactly one of:`,
    `  - "created"     — file did not exist before; you created it`,
    `  - "deleted"     — file existed before; you removed it`,
    `  - "edited"      — file existed before; you modified its contents`,
    `  - "referenced"  — you read the file as context but did not change it`,
    ``,
    `Set "taskResult" to:`,
    `  - "completed"  — the requested task outcome was fully achieved`,
    `  - "partial"    — some requested outcomes were achieved, but not all`,
    `  - "blocked"    — sandbox, auth, missing dependency, or another external`,
    `                   constraint prevented the requested outcome`,
    `  - "failed"     — you could not complete the requested outcome for any`,
    `                   other reason`,
    ``,
    trackReferences
      ? `Include EVERY file you read, modified, created, or deleted — including files you only inspected for context.`
      : `In "files", include only files you created, edited, or deleted. Do NOT include files you only read for context.`,
    `Use repo-relative paths where possible. Files outside the working directory may use absolute paths.`,
    ``,
    `If no files should be reported under that rule, use an empty object for "files".`,
    ``,
    `Your final message is the ONLY thing the wrapper sees — make sure it is`,
    `just the JSON object above, nothing else.`,
  );
  return lines.join('\n');
}

// ---------- runtime ----------

function buildSpawnArgs({ workdir, lastMessagePath, model, permissions, profile, reasoningEffort }) {
  // We always pass --ephemeral (this is a one-shot delegated task, not part
  // of a persisted interactive session). --sandbox is set from --permissions.
  //
  // The structured result is captured via codex's --output-last-message flag,
  // which writes the agent's FINAL message text to the given path. This is a
  // codex-process write (NOT a model-driven write), so it bypasses --sandbox
  // entirely — works fine even under read-only. Empirically verified against
  // codex 0.128.0.
  //
  // Approval policy: codex exec defaults to 'never' in 0.128.0 and does NOT
  // expose --ask-for-approval (it's a top-level codex flag, not an exec flag).
  // Passing it on exec is a hard error, so we rely on the exec default.
  const sandbox = PERMISSIONS[permissions].sandbox;
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox', sandbox,
    '--cd', workdir,
    '--model', model,
    '--output-last-message', lastMessagePath,
  ];
  if (reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
  }
  if (profile) args.push('--profile', profile);
  return args;
}

function spawnCodex(args, options = {}) {
  const isWin = process.platform === 'win32';
  return spawn('codex', args, {
    ...options,
    shell: isWin,
  });
}

function checkCodexAvailable(env) {
  return new Promise((resolveP) => {
    const child = spawnCodex(['--version'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      resolveP({
        ok: false,
        error: formatCodexUnavailable(e, ''),
      });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolveP({ ok: true, version: stdout.trim() || stderr.trim() });
        return;
      }
      resolveP({
        ok: false,
        error: formatCodexUnavailable(null, stderr || stdout),
      });
    });
  });
}

function formatCodexUnavailable(error, output) {
  const detail = output.trim() || error?.message || 'no diagnostic output';
  const missing = error?.code === 'ENOENT'
    || /not recognized|not found|command not found|could not find/i.test(detail);
  if (missing) {
    return `codex CLI was not found on PATH. Install OpenAI Codex, run "codex login", then retry. Diagnostic: ${detail}`;
  }
  return `failed to run "codex --version". Verify OpenAI Codex is installed and runnable, then retry. Diagnostic: ${detail}`;
}

function runCodex({ prompt, env, args, streamThinking }) {
  return new Promise((resolveP, rejectP) => {
    // On Windows codex is a .cmd shim — post-CVE-2024-27980 Node refuses to
    // spawn .cmd without shell:true (EINVAL). shell:true emits DEP0190 (we
    // suppress it; args here are static flags + paths with no shell metachars).
    // Prompt itself is piped via stdin to dodge shell-arg-concat splitting.
    const child = spawnCodex(args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutTail = '';
    let stderrTail = '';
    child.stdout?.on('data', (d) => {
      const text = d.toString();
      stdoutTail += text;
      if (stdoutTail.length > 4000) stdoutTail = stdoutTail.slice(-4000);
      if (streamThinking) process.stderr.write(text);
    });
    child.stderr?.on('data', (d) => {
      const text = d.toString();
      stderrTail += text;
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
      if (streamThinking) process.stderr.write(text);
    });
    child.on('error', rejectP);
    child.on('close', (code) => resolveP({ code: code ?? -1, stdoutTail, stderrTail }));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function formatCodexRunFailure(runResult) {
  const tail = (runResult.stderrTail || runResult.stdoutTail || '').trim();
  const detail = tail || 'codex produced no diagnostic output';
  const hint = codexFailureHint(detail);
  return `codex exited with code ${runResult.code}. ${hint}Diagnostic tail: ${detail}`;
}

function codexFailureHint(detail) {
  if (/missing bearer|authentication|unauthorized|401|login/i.test(detail)) {
    return 'Codex appears to be unauthenticated or the login expired; run "codex login" and retry. ';
  }
  if (/quota|rate limit|usage limit|limit exceeded/i.test(detail)) {
    return 'Codex appears to have hit a quota or rate limit; wait for quota reset or use a different plan/model. ';
  }
  if (/model_reasoning_effort|reasoning[_ ]?effort/i.test(detail)) {
    return 'The chosen --reasoning-effort may not be supported for this model/plan; drop --reasoning-effort or pick a supported level (e.g. low, medium, high). ';
  }
  if (/not supported.*ChatGPT account|model .*not supported|400/i.test(detail)) {
    return 'The selected model may not be available for this ChatGPT account; retry without --model or choose a supported model. ';
  }
  if (/sandbox|permission denied|operation not permitted|patch rejected|read-only/i.test(detail)) {
    return 'Codex hit a filesystem or sandbox restriction; check --permissions and the target path. ';
  }
  return '';
}

function readResult(lastMessagePath) {
  // The "result" is whatever the model wrote as its final message; codex
  // captured it via --output-last-message. We told the model the message
  // must be a single JSON object, but models love to add fences or prose
  // anyway. Try strict parse first, then fall back to extracting the first
  // top-level {...} substring (simple brace-depth scan; handles strings).
  if (!existsSync(lastMessagePath)) {
    return { ok: false, error: `codex did not write a final message file at ${lastMessagePath}` };
  }
  let raw;
  try { raw = readFileSync(lastMessagePath, 'utf8'); }
  catch (e) { return { ok: false, error: `failed to read final message file: ${e.message}` }; }
  if (!raw.trim()) {
    return { ok: false, error: 'codex final message was empty' };
  }
  // Strip a leading ```json fence and trailing ``` if codex wrapped the file
  // despite our instructions — a common pattern for LLMs writing "JSON files".
  const stripped = raw
    .replace(/^\s*```(?:json)?\s*\n/i, '')
    .replace(/\n```\s*$/i, '')
    .trim();
  // Try strict parse first (the common case if the model behaved).
  try {
    const parsed = JSON.parse(stripped);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: 'result root is not a JSON object' };
    }
    return { ok: true, value: parsed };
  } catch { /* fall through to lenient extraction */ }
  // Lenient: scan for the first balanced {...} block, respecting JSON string
  // quoting (don't count braces inside strings).
  const block = extractFirstJsonObject(stripped);
  if (!block) {
    return { ok: false, error: 'codex final message is not valid JSON and contains no extractable JSON object' };
  }
  let parsed;
  try { parsed = JSON.parse(block); }
  catch (e) { return { ok: false, error: `extracted JSON candidate failed to parse: ${e.message}` }; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'extracted JSON root is not an object' };
  }
  return { ok: true, value: parsed, warning: 'codex final message had surrounding non-JSON content; extracted the first JSON object' };
}

function extractFirstJsonObject(s) {
  // Brace-depth scan honoring JSON strings + escape sequences. Returns the
  // matched substring or null if no balanced object is found. Doesn't validate
  // the JSON — that's JSON.parse's job afterward.
  const i0 = s.indexOf('{');
  if (i0 === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = i0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(i0, i + 1);
    }
  }
  return null;
}

function normalizeResult(parsed, { trackReferences }) {
  const warnings = [];
  let taskResult = parsed.taskResult;
  let summary = parsed.summary;
  let details = parsed.details;
  let files = parsed.files;

  if (typeof taskResult !== 'string') {
    warnings.push(`result.taskResult missing or not a string; got ${typeOf(taskResult)}`);
    taskResult = 'failed';
  } else {
    taskResult = taskResult.toLowerCase().trim();
    if (!ALLOWED_TASK_RESULTS.has(taskResult)) {
      warnings.push(`result.taskResult has unknown value "${parsed.taskResult}"; recording as "failed"`);
      taskResult = 'failed';
    }
  }

  if (typeof summary !== 'string') {
    warnings.push(`result.summary missing or not a string; got ${typeOf(summary)}`);
    summary = '';
  }
  if (typeof details !== 'string') {
    warnings.push(`result.details missing or not a string; got ${typeOf(details)}`);
    details = '';
  }
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    warnings.push(`result.files missing or not an object; got ${typeOf(files)}`);
    files = {};
  }

  const normalizedFiles = {};
  for (const [path, rawAction] of Object.entries(files)) {
    if (typeof rawAction !== 'string') {
      warnings.push(`files["${path}"] action is not a string (got ${typeOf(rawAction)}); recording as "referenced"`);
      if (trackReferences) normalizedFiles[path] = 'referenced';
      continue;
    }
    const action = rawAction.toLowerCase().trim();
    if (ALLOWED_ACTIONS.has(action)) {
      if (action !== 'referenced' || trackReferences) normalizedFiles[path] = action;
    } else {
      warnings.push(`files["${path}"] has unknown action "${rawAction}"; recording as "referenced"`);
      if (trackReferences) normalizedFiles[path] = 'referenced';
    }
  }

  return { taskResult, summary, details, files: normalizedFiles, warnings };
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function emit(r, code, outPath) {
  const json = JSON.stringify(r, null, 2) + '\n';
  process.stdout.write(json);
  if (outPath) {
    try { writeFileSync(outPath, json); }
    catch (e) {
      process.stderr.write(`warning: failed to write --out ${outPath}: ${e.message}\n`);
    }
  }
  process.exit(code);
}

// ---------- main ----------

async function main() {
  maybeRunInstaller(process.argv.slice(2));
  const args = parseArgs(process.argv.slice(2));
  let attempt = 0; // number of `codex exec` invocations so far; incremented at each retry-loop top
  const retriesEnabled = args.retries > 0;
  const start = Date.now();
  const warnings = [];

  // Warn (never block) when the skill isn't registered with any harness —
  // the common case after a bare `npm install -g codex-task`. Goes to stderr
  // for humans and into the warnings array for the parent agent. The run
  // itself works fine without the skill; this is discoverability only.
  if (!args.noInstallCheck && !process.env.CODEX_TASK_SKIP_INSTALL_CHECK) {
    // The probe must never abort the run: os.homedir() can throw (e.g. on
    // Windows with HOME/USERPROFILE unset), and a check failure is strictly
    // less important than the task itself.
    try {
      if (!skillProbePaths().some((p) => existsSync(p))) {
        const msg = 'codex-task skill is not registered with any known coding-agent harness; '
          + 'run "codex-task --install" (or "node codex-task.mjs --install") to register it, '
          + 'or pass --no-install-check to silence this warning';
        warnings.push(msg);
        process.stderr.write(`warning: ${msg}\n`);
      }
    } catch (e) {
      warnings.push(`skill registration check skipped: ${e.message}`);
    }
  }

  // Resolve workdir. Default: caller's cwd. --cwd accepts relative or absolute.
  const callerCwd = process.cwd();
  const workdir = args.cwd
    ? (isAbsolute(args.cwd) ? args.cwd : resolve(callerCwd, args.cwd))
    : callerCwd;
  if (!existsSync(workdir)) {
    return emit({
      ok: false,
      error: `--cwd ${args.cwd || workdir} does not exist`,
      taskResult: 'failed',
      summary: '', details: '', files: {},
      workdir, sessionDir: null,
      model: args.model, permissions: args.permissions, reasoningEffort: args.reasoningEffort,
      ...(retriesEnabled ? { attempts: attempt } : {}),
      warnings, durationMs: Date.now() - start,
    }, 2, args.out);
  }

  const env = { ...process.env };
  delete env.OPENAI_API_KEY;

  const codexCheck = await checkCodexAvailable(env);
  if (!codexCheck.ok) {
    return emit({
      ok: false,
      error: codexCheck.error,
      taskResult: 'failed',
      summary: '', details: '', files: {},
      workdir, sessionDir: null,
      model: args.model, permissions: args.permissions, reasoningEffort: args.reasoningEffort,
      ...(retriesEnabled ? { attempts: attempt } : {}),
      warnings, durationMs: Date.now() - start,
    }, 1, args.out);
  }

  // Per-session scratch dir lives in the OS temp area, NOT inside the workdir.
  // The codex CLI process (NOT the model) writes the agent's final message to
  // <sessionDir>/last-message.txt via --output-last-message, so this dir is
  // a wrapper-level write only — model sandbox does not apply.
  const sessionId = `${Date.now()}-${process.pid}`;
  const sessionDir = join(tmpdir(), 'codex-task', sessionId);
  const lastMessagePath = join(sessionDir, 'last-message.txt');
  try {
    mkdirSync(sessionDir, { recursive: true });
  } catch (e) {
    return emit({
      ok: false,
      error: `failed to create session dir ${sessionDir}: ${e.message}`,
      taskResult: 'failed',
      summary: '', details: '', files: {},
      workdir, sessionDir,
      model: args.model, permissions: args.permissions, reasoningEffort: args.reasoningEffort,
      ...(retriesEnabled ? { attempts: attempt } : {}),
      warnings, durationMs: Date.now() - start,
    }, 1, args.out);
  }

  const prompt = buildPrompt(args.prompt, {
    permissions: args.permissions,
    trackReferences: args.trackReferences,
  });
  const spawnArgs = buildSpawnArgs({
    workdir,
    lastMessagePath,
    model: args.model,
    permissions: args.permissions,
    profile: args.profile,
    reasoningEffort: args.reasoningEffort,
  });

  // Retry loop (Trigger A only): sequential, in-process. `attempts <= retries`
  // gates a retry; a clean (code 0) exit always `break`s immediately — no
  // clean-exit taskResult (including "blocked") is ever retried. The
  // pre-attempt rmSync is mandatory even on attempt 1 (force:true no-ops the
  // first time) so a prior failed attempt never leaves a stale final message
  // for the next attempt's readResult to see.
  let runResult;
  for (;;) {
    attempt++;
    rmSync(lastMessagePath, { force: true });
    try {
      runResult = await runCodex({
        prompt,
        env,
        args: spawnArgs,
        streamThinking: args.streamThinking && !args.quiet,
      });
    } catch (e) {
      return emit({
        ok: false,
        error: `failed to spawn codex: ${e.message}`,
        taskResult: 'failed',
        summary: '', details: '', files: {},
        workdir, sessionDir,
        model: args.model, permissions: args.permissions, reasoningEffort: args.reasoningEffort,
        ...(retriesEnabled ? { attempts: attempt } : {}),
        warnings, durationMs: Date.now() - start,
      }, 1, args.out);
    }

    if (runResult.code === 0) break; // clean exit: never retried, proceed below

    const { label: cls, line: diagLine } = classifyFailure(tailOf(runResult));
    if (cls && attempt <= args.retries) {
      warnings.push(`codex attempt ${attempt}/${args.retries + 1} failed (${cls}): ${diagLine}; retrying`);
      if (RETRY_BACKOFF_MS > 0) await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    break; // non-transient, or transient but retries exhausted
  }

  if (runResult.code !== 0) {
    return emit({
      ok: false,
      error: formatCodexRunFailure(runResult),
      taskResult: 'failed',
      summary: '', details: '', files: {},
      workdir, sessionDir,
      model: args.model, permissions: args.permissions, reasoningEffort: args.reasoningEffort,
      ...(retriesEnabled ? { attempts: attempt } : {}),
      warnings, durationMs: Date.now() - start,
    }, 1, args.out);
  }

  const read = readResult(lastMessagePath);
  if (!read.ok) {
    warnings.push(read.error);
    return emit({
      ok: false,
      error: read.error,
      taskResult: 'failed',
      summary: '', details: '', files: {},
      workdir, sessionDir,
      model: args.model, permissions: args.permissions, reasoningEffort: args.reasoningEffort,
      ...(retriesEnabled ? { attempts: attempt } : {}),
      warnings, durationMs: Date.now() - start,
    }, 1, args.out);
  }
  if (read.warning) warnings.push(read.warning);

  const norm = normalizeResult(read.value, { trackReferences: args.trackReferences });
  warnings.push(...norm.warnings);

  let cleanedUp = false;
  if (!args.debug) {
    try {
      rmSync(sessionDir, { recursive: true, force: true });
      cleanedUp = true;
    } catch (e) {
      warnings.push(`failed to clean up scratch dir ${sessionDir}: ${e.message}`);
    }
  }

  const ok = norm.taskResult === 'completed';
  emit({
    ok,
    taskResult: norm.taskResult,
    summary: norm.summary,
    details: norm.details,
    files: norm.files,
    workdir,
    sessionDir: cleanedUp ? null : sessionDir,
    model: args.model,
    permissions: args.permissions,
    reasoningEffort: args.reasoningEffort,
    ...(retriesEnabled ? { attempts: attempt } : {}),
    warnings,
    durationMs: Date.now() - start,
  }, ok ? 0 : 1, args.out);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});

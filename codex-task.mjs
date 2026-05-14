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
 *     "summary": "...",
 *     "details": "...",
 *     "files": { "<path>": "<created|deleted|edited|referenced>", ... },
 *     "workdir":   "<absolute path codex was --cd'd to>",
 *     "sessionDir":"<tmp dir under workdir, removed on success>",
 *     "warnings": [],
 *     "durationMs": 12345
 *   }
 *
 * Codex's own log output streams live to stderr so callers can follow
 * progress; structured stdout is the JSON only (always last, always valid).
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

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

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

// ---------- arg parsing ----------

function parseArgs(argv) {
  let prompt = '';
  let promptFile = '';
  let cwd = '';
  let out = '';
  let debug = false;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--prompt') { prompt = next ?? ''; i++; }
    else if (arg === '--prompt-file') { promptFile = next ?? ''; i++; }
    else if (arg === '--cwd') { cwd = next ?? ''; i++; }
    else if (arg === '--out') { out = next ?? ''; i++; }
    else if (arg === '--debug') { debug = true; }
    else if (arg === '--quiet') { quiet = true; }
    else if (arg === '-h' || arg === '--help') { printUsage(process.stdout); process.exit(0); }
    else { usageErr(`unknown argument "${arg}"`); }
  }

  if (prompt && promptFile) usageErr('--prompt and --prompt-file are mutually exclusive');
  if (promptFile) prompt = readPromptFile(promptFile, '--prompt-file');
  if (!prompt) { printUsage(process.stderr); process.exit(2); }

  return { prompt, cwd, out, debug, quiet };
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
  stream.write(
    `Usage:
  node codex-task.mjs (--prompt "<text>" | --prompt-file <path>)
                      [--cwd DIR] [--out FILE] [--debug] [--quiet]

Wrap a single 'codex exec' invocation, run an arbitrary agent task, and
capture a structured JSON result describing what files were touched.

  --prompt       Inline task description. Anything you'd tell codex to do.
  --prompt-file  Read the task description from a UTF-8 text file. Mutually
                 exclusive with --prompt. Trailing whitespace is trimmed;
                 internal newlines are preserved.
  --cwd          Working directory codex operates inside (relative to caller
                 cwd, or absolute). Default: caller cwd. codex's workspace-
                 write sandbox is confined to this directory.
  --out          Also write the result JSON to this file path (still printed
                 to stdout). Useful for piping or persisting.
  --debug        Keep the per-session tmp dir on success. Default cleans it
                 up. Failures always preserve tmp regardless.
  --quiet        Discard codex's live log output instead of streaming it to
                 stderr. By default codex chatter prints to stderr so callers
                 can follow progress; structured stdout (JSON) is unaffected.

Output: JSON on stdout. Shape:

  {
    "ok": true,
    "summary":    "<one or two sentences>",
    "details":    "<markdown>",
    "files":      { "<path>": "<created|deleted|edited|referenced>", ... },
    "workdir":    "<absolute --cwd>",
    "sessionDir": "<tmp work dir, removed on success unless --debug>",
    "warnings":   [],
    "durationMs": 12345
  }

The per-session tmp dir is <workdir>/.codex-task-tmp/<sessionId>/ and is
removed automatically on success unless --debug is set. Failures preserve it
for debugging. Add ".codex-task-tmp/" to your project's .gitignore.

Subscription billing: OPENAI_API_KEY is stripped from the spawned env so
codex routes to ChatGPT subscription quota, not API tokens.
`,
  );
}

// ---------- prompt synthesis ----------

function buildPrompt(userPrompt, resultPath) {
  // Posix-style path for the prompt — codex normalizes either, but forward
  // slashes avoid backslash-escape ambiguity in its tool-call parsing.
  const resultPathP = resultPath.replace(/\\/g, '/');
  return [
    `You are being invoked through a wrapper that captures a structured result.`,
    ``,
    `TASK:`,
    userPrompt,
    ``,
    `When you have completed the task, write a JSON file to this exact path:`,
    `  ${resultPathP}`,
    ``,
    `The JSON file must follow this shape exactly — no other top-level keys, no`,
    `surrounding prose, no markdown fences:`,
    ``,
    `{`,
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
    `Include EVERY file you read, modified, created, or deleted — including ones`,
    `you only inspected for context. Use repo-relative paths where possible (the`,
    `working directory above is the project root). Files outside the working`,
    `directory may use absolute paths.`,
    ``,
    `If the task is purely informational (no files touched), use an empty object`,
    `for "files".`,
    ``,
    `Do not include the JSON in your normal output — only write it to the file`,
    `path above. After the file is written and the task is done, stop.`,
  ].join('\n');
}

// ---------- runtime ----------

function runCodex({ prompt, env, cwd, quiet }) {
  return new Promise((resolveP, rejectP) => {
    // On Windows codex is a .cmd shim — post-CVE-2024-27980 Node refuses to
    // spawn .cmd without shell:true (EINVAL). shell:true emits DEP0190 (we
    // suppress it; args here are static flags + a path with no shell metachars).
    // Prompt itself is piped via stdin to dodge shell-arg-concat splitting.
    const isWin = process.platform === 'win32';
    // --skip-git-repo-check: users will run this inside their own (often
    // untrusted-to-codex) repos. We've already accepted --full-auto for
    // hands-off execution; skipping the trust prompt is consistent with that.
    const child = spawn('codex', ['exec', '--full-auto', '--skip-git-repo-check', '--cd', cwd], {
      env,
      stdio: ['pipe', quiet ? 'ignore' : 'inherit', quiet ? 'pipe' : 'inherit'],
      shell: isWin,
    });
    // When stderr is 'pipe' (quiet mode) we still want a tail for error
    // reporting. When 'inherit', we let it flow through to the user's terminal
    // and have no captured tail — codex's diagnostics are already visible.
    let stderrTail = '';
    if (quiet && child.stderr) {
      child.stderr.on('data', (d) => {
        stderrTail += d.toString();
        // Cap to avoid unbounded growth on a chatty failure.
        if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
      });
    }
    child.on('error', rejectP);
    child.on('close', (code) => resolveP({ code: code ?? -1, stderrTail }));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function readResult(resultPath) {
  // Returns { ok: true, value } | { ok: false, error }. Validates shape but
  // doesn't normalize — that happens in the caller so warnings flow into the
  // final result.warnings array.
  if (!existsSync(resultPath)) {
    return { ok: false, error: `result file not written by codex at ${resultPath}` };
  }
  let raw;
  try { raw = readFileSync(resultPath, 'utf8'); }
  catch (e) { return { ok: false, error: `failed to read result file: ${e.message}` }; }
  // Strip a leading ```json fence and trailing ``` if codex wrapped the file
  // despite our instructions — a common pattern for LLMs writing "JSON files".
  const stripped = raw
    .replace(/^\s*```(?:json)?\s*\n/i, '')
    .replace(/\n```\s*$/i, '')
    .trim();
  let parsed;
  try { parsed = JSON.parse(stripped); }
  catch (e) { return { ok: false, error: `result file is not valid JSON: ${e.message}` }; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'result file root is not a JSON object' };
  }
  return { ok: true, value: parsed };
}

function normalizeResult(parsed) {
  // Returns { summary, details, files, warnings[] }. Coerces missing fields
  // to safe defaults and warns rather than failing — the run still succeeded
  // even if codex was sloppy about the schema.
  const warnings = [];
  let summary = parsed.summary;
  let details = parsed.details;
  let files = parsed.files;

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
      normalizedFiles[path] = 'referenced';
      continue;
    }
    const action = rawAction.toLowerCase().trim();
    if (ALLOWED_ACTIONS.has(action)) {
      normalizedFiles[path] = action;
    } else {
      warnings.push(`files["${path}"] has unknown action "${rawAction}"; recording as "referenced"`);
      normalizedFiles[path] = 'referenced';
    }
  }

  return { summary, details, files: normalizedFiles, warnings };
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
      // Already written to stdout — surface to stderr but don't change exit code.
      process.stderr.write(`warning: failed to write --out ${outPath}: ${e.message}\n`);
    }
  }
  process.exit(code);
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const start = Date.now();
  const warnings = [];

  // Resolve workdir. Default: caller's cwd. --cwd accepts relative or absolute.
  const callerCwd = process.cwd();
  const workdir = args.cwd
    ? (isAbsolute(args.cwd) ? args.cwd : resolve(callerCwd, args.cwd))
    : callerCwd;
  if (!existsSync(workdir)) {
    return emit({
      ok: false,
      error: `--cwd ${args.cwd || workdir} does not exist`,
      summary: '', details: '', files: {},
      workdir, sessionDir: null,
      warnings, durationMs: Date.now() - start,
    }, 2, args.out);
  }

  // Per-session tmp dir lives inside the workdir so codex's workspace-write
  // sandbox covers it (codex is --cd'd to workdir). It's removed on success.
  const tmpRoot = resolve(workdir, '.codex-task-tmp');
  const sessionId = `${Date.now()}-${process.pid}`;
  const sessionDir = join(tmpRoot, sessionId);
  const resultPath = join(sessionDir, 'result.json');
  try {
    mkdirSync(sessionDir, { recursive: true });
  } catch (e) {
    return emit({
      ok: false,
      error: `failed to create session dir ${sessionDir}: ${e.message}`,
      summary: '', details: '', files: {},
      workdir, sessionDir,
      warnings, durationMs: Date.now() - start,
    }, 1, args.out);
  }

  const prompt = buildPrompt(args.prompt, resultPath);

  const env = { ...process.env };
  delete env.OPENAI_API_KEY;

  let runResult;
  try {
    runResult = await runCodex({ prompt, env, cwd: workdir, quiet: args.quiet });
  } catch (e) {
    return emit({
      ok: false,
      error: `failed to spawn codex: ${e.message}`,
      summary: '', details: '', files: {},
      workdir, sessionDir,
      warnings, durationMs: Date.now() - start,
    }, 1, args.out);
  }

  if (runResult.code !== 0) {
    const tail = args.quiet ? runResult.stderrTail.slice(-500).trim() : '(streamed to terminal)';
    return emit({
      ok: false,
      error: `codex exited with code ${runResult.code}. stderr tail: ${tail}`,
      summary: '', details: '', files: {},
      workdir, sessionDir,
      warnings, durationMs: Date.now() - start,
    }, 1, args.out);
  }

  const read = readResult(resultPath);
  if (!read.ok) {
    warnings.push(read.error);
    return emit({
      ok: false,
      error: read.error,
      summary: '', details: '', files: {},
      workdir, sessionDir,
      warnings, durationMs: Date.now() - start,
    }, 1, args.out);
  }

  const norm = normalizeResult(read.value);
  warnings.push(...norm.warnings);

  // Cleanup tmp on success unless --debug. Failures keep tmp unconditionally
  // (we wouldn't reach here on a failure — the early returns above bail out
  // with sessionDir preserved). Cleanup errors are warnings, not failures.
  let cleanedUp = false;
  if (!args.debug) {
    try {
      rmSync(sessionDir, { recursive: true, force: true });
      cleanedUp = true;
      // Best-effort: prune the tmpRoot dir if it's now empty, so we don't
      // leave a stray ".codex-task-tmp/" sitting in the user's project.
      try { rmSync(tmpRoot, { recursive: false }); } catch { /* not empty, fine */ }
    } catch (e) {
      warnings.push(`failed to clean up tmp session dir ${sessionDir}: ${e.message}`);
    }
  }

  emit({
    ok: true,
    summary: norm.summary,
    details: norm.details,
    files: norm.files,
    workdir,
    sessionDir: cleanedUp ? null : sessionDir,
    warnings,
    durationMs: Date.now() - start,
  }, 0, args.out);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});

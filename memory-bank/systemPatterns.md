# systemPatterns

## Architecture
Single-process Node ESM script. No daemon, no state, no IPC beyond the spawned codex child. One subcommand: read prompt, build wrapper prompt, spawn codex, wait, read structured result file, emit JSON.

```
caller (Claude Code / opencode / shell)
   │  --prompt / --prompt-file
   │  --cwd / --out / --debug / --quiet / --stream-thinking / --track-references
   │  --model / --permissions / --profile
   ▼
codex-task.mjs
   │  parseArgs → resolve workdir → mkdir <os.tmpdir()>/codex-task/<sessionId>/
   │  codex --version preflight (structured error if missing/not runnable)
   │  buildPrompt (tell model: your FINAL message must be a single JSON
   │               object of this shape; add a read-only addendum when
   │               --permissions=read-only so codex knows to describe
   │               edits in details rather than fail on writes)
   │  buildSpawnArgs:
   │    codex exec
   │      --skip-git-repo-check
   │      --ephemeral
   │      --sandbox <mapped from --permissions>
   │      --cd <workdir>
   │      --model <model>
   │      --output-last-message <sessionDir>/last-message.txt
   │      [--profile <name>]       # if provided
   │  spawn with env minus OPENAI_API_KEY; prompt piped via stdin
   │  codex stdout/stderr → captured tails; mirrored to stderr only with --stream-thinking
   ▼
codex CLI (ChatGPT-authed)
   │  reads/writes files per --sandbox policy
   │  AFTER agent exits: codex's CLI process writes the agent's final
   │  message text to <sessionDir>/last-message.txt. This is a wrapper-
   │  process write, NOT a model-driven write, so it bypasses --sandbox
   │  entirely — works under read-only.
   ▼
readResult:
   read last-message.txt → strip ```json fences →
   try strict JSON.parse → on failure, extract first balanced {...} block
                            (string-quote-aware brace counting) →
   try JSON.parse on the extracted block
normalizeResult (validate taskResult; coerce unknown action verbs to "referenced";
                 drop referenced files unless --track-references;
                 coerce missing fields with warnings) →
rmSync(<sessionDir>) unless --debug or !ok →
emit JSON to stdout (and optionally --out file)
```

## Major design choices

- **No npm deps.** Trivial install, no node_modules, no supply chain.
- **Single subcommand, no dispatch.** Unlike `codex-image-gen` which has `generate`/`edit` modes, `codex-task` is one shape: prompt in, structured result out. Keeps argparse simple.
- **Strip `OPENAI_API_KEY`** from spawned env. If codex sees it, it silently switches to API billing.
- **Do not override `CODEX_HOME`.** Codex stores ChatGPT auth there; overriding → fresh-install state → 401. Codex#11435 parallel-corruption only matters concurrently; this tool is serial-by-design.
- **Prompt via stdin, not argv.** On Windows `shell:true` is required to spawn `codex.cmd` (post-CVE-2024-27980), but Node concatenates args without escaping under `shell:true`, so multi-word prompts split. Stdin sidesteps this.
- **`--cd` to the user's workdir, not a sandbox.** Unlike `codex-image-gen` which sandboxes codex in a fresh tmp dir, `codex-task` deliberately points codex at the user's project. The whole point is for codex to perform work on the user's files. The blast radius is bounded by codex's `--sandbox` policy (settable via our `--permissions`), which is in turn confined to `--cd`.
- **`read-only` is the default permission.** Most delegated agent work is investigation, not modification — "find every X", "summarize Y", "audit Z". Defaulting the sandbox to read-only makes "I tried codex-task and it broke my repo" impossible by construction. Refactors / edits opt in via `--permissions workspace-write`; cross-tree writes require `danger-full-access`.
- **Scratch dir lives in OS temp, NOT inside the workdir.** Path: `<os.tmpdir()>/codex-task/<sessionId>/`. Contains a single file `last-message.txt`. Side benefit: user's project is never polluted with a wrapper-owned dir, so nothing to add to `.gitignore`.
- **Structured result via `--output-last-message`, not a model-written file.** Codex's `--output-last-message <path>` flag tells the codex CLI process to write the agent's FINAL message text to a file *after* the agent exits. This is a wrapper-process write — the model sandbox does NOT apply — so it works under any `--sandbox` policy including `read-only`. Empirically verified against codex 0.128.0. We attempted the alternative (model writes result.json itself, with `--add-dir <sessionDir>` granting write access) but `--add-dir` does NOT override `--sandbox read-only`; the model's writes were blocked by the read-only policy with `patch rejected: writing is blocked by read-only sandbox`.
- **`--ephemeral` always.** Each invocation is a one-shot delegated task, not part of a persisted interactive session. We don't want to clutter codex's session history with wrapper-driven exec runs.
- **Approval policy is `never` by default in `codex exec`.** We rely on this default rather than passing `--ask-for-approval` ourselves, because `--ask-for-approval` is a top-level `codex` flag and is NOT exposed on the `exec` subcommand (passing it crashes with "unexpected argument"). Codex's `exec` run header confirms `approval: never` without us doing anything.
- **`--skip-git-repo-check`.** Users will run this inside their own (often untrusted-to-codex) repos. We've already accepted hands-off operation; skipping the trust prompt is consistent.
- **Posix-style path inside the prompt** (`replace(/\\/g, '/')`) — codex normalizes both, but forward slashes avoid backslash-escape ambiguity in tool-call parsing.
- **Conditional prompt addendum under `read-only`.** When `--permissions=read-only` is set, the prompt explicitly tells codex to describe intended edits in `details` rather than fail on writes. Without this, codex might attempt writes, hit sandbox denials, and produce a degraded result. With it, codex knows up front that it's in audit mode. The structured result still gets delivered via `--output-last-message` regardless.
- **Codex thinking is opt-in.** Final JSON goes to stdout. Codex stdout/stderr is captured to bounded tails by default and is not streamed into the parent-agent context. `--stream-thinking` mirrors it live to wrapper stderr when a human wants to watch; `--quiet` suppresses streaming. Stdout remains exactly one JSON document.
- **Markdown-fence stripping + lenient JSON extraction.** LLMs love to wrap their "JSON" final messages in ` ```json ` fences or sprinkle in commentary despite explicit instructions. We strip a leading fence and trailing ```, then try strict `JSON.parse`. On failure, we fall back to scanning for the first balanced `{...}` block (depth-aware, JSON-string-quote-aware) and parsing that — with a warning. Common-case lenience without sacrificing the strict-shape contract.
- **Unknown action verbs are demoted, not rejected.** If codex returns `"modified"` or `"updated"` for a file action, we coerce to `"referenced"` and emit a warning. Rationale: the wrapper's job is to give the parent agent a stable schema; rejecting the whole run because codex used a synonym would be hostile. The warning surfaces the issue for tightening prompts later.
- **Cleanup-on-success default.** On `ok && !--debug`, `rmSync(sessionDir, {recursive:true, force:true})` runs before emit. Failed runs preserve scratch unconditionally so the user can investigate. Cleanup failures are non-fatal — recorded as a warning, the run still reports `ok:true`.
- **Task outcome is explicit.** Codex must return `taskResult: completed|partial|blocked|failed`. Wrapper `ok` is true only for `completed`; `partial`, `blocked`, and `failed` exit nonzero with structured JSON.
- **Reference tracking is opt-in.** By default the `files` map includes only `created|edited|deleted` entries. `referenced` entries are kept only with `--track-references`, reducing parent-agent context for normal delegation.
- **Soft schema validation, not strict.** Missing `taskResult` / `summary` / `details` / `files` → coerced to safe defaults with warnings. Hard failures are reserved for: codex exiting non-zero, no result file written, result file not valid JSON, or root not an object.
- **Model passes through; no client-side validation.** The set of supported models is plan-dependent and not enumerable. Codex validates server-side and returns 400 with a clear message ("not supported when using Codex with a ChatGPT account") which surfaces to the wrapper's `error` field. Wrapper just lists common known names in `--help` as hints.
- **No `full-auto` wrapper permission.** Codex deprecated the historical `--full-auto` shorthand. The wrapper accepts only canonical sandbox names: `read-only`, `workspace-write`, and `danger-full-access`.
- **Preflight and failure hints.** Before `codex exec`, the wrapper runs `codex --version`. If the binary is missing or not runnable, it returns structured JSON with install/login guidance. Non-zero `codex exec` exits include a captured diagnostic tail and pattern-based hints for expired login (`codex login`), quota/rate limits, unsupported model, and sandbox/filesystem denials.

## Component relationships

- `codex-task.mjs` — runtime. Pure: parse args → build wrapper prompt → spawn codex → read result file → normalize → emit JSON.
- `install.mjs` — multi-target installer. Verifies `node` + `codex` on PATH, copies the tool to `~/.codex-task/`, renders SKILL.md, then iterates a `TARGETS` registry to drop the rendered skill into each selected harness's user-global skills dir. For Claude Code, also idempotently patches `~/.claude/settings.json` `permissions.allow` with the `Bash(node <SCRIPT_PATH> *)` rule. Other harnesses are permissive by default and get no settings patch. The `agents` cross-harness target is `explicitOnly: true`. Flags: `--target=<csv>` / `--all` / `--no-<id>` / `--list-targets` / `--uninstall`.
- `SKILL.md` — Anthropic-style skill template (frontmatter: `name` + `description` + `allowed-tools`). Tells the agent when to invoke and what arguments to pass. Two placeholders (`<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>`) are rendered by the installer.

## Critical flows

### Install
Same `TARGETS` registry pattern as `codex-image-gen`. See `codex-image-gen/memory-bank/systemPatterns.md` for the full flow — only the install dir (`~/.codex-task/`) and skill subfolder name (`codex-task`) differ.

### Run
1. `parseArgs(process.argv.slice(2))` — resolve `--prompt` / `--prompt-file` (mutually exclusive; UTF-8 read with `.trim()`, empty-after-trim rejected); resolve `--cwd` (relative or absolute; defaults to caller cwd; must exist or exit 2); validate `--permissions` against `read-only|workspace-write|danger-full-access` (default `read-only`); parse `--stream-thinking` and `--track-references`; take `--model` verbatim (default `gpt-5.5`) and pass `--profile` through if present. `-h`/`--help` prints usage to stdout, exits 0.
2. Make `<os.tmpdir()>/codex-task/<sessionId>/` with `<sessionId>` = `<timestamp>-<pid>`. Pre-allocate the result-file path inside.
3. Build the wrapper prompt: fixed preamble telling the model its FINAL message must be a single JSON object with `taskResult`, `summary`, `details`, `files` + user task + (when `--permissions=read-only`) a read-only addendum telling codex to set `taskResult:"blocked"` for blocked writes. The prompt asks for referenced files only under `--track-references`.
4. Build the spawn args: `exec --skip-git-repo-check --ephemeral --sandbox <mapped> --cd <workdir> --model <model> --output-last-message <sessionDir>/last-message.txt`, plus `--profile <name>` if provided. Approval defaults to `never` automatically in `codex exec`. There is no wrapper `--search` flag; when the task prompt explicitly asks for web research, Codex can use web search from `codex exec`.
5. Preflight `codex --version` with `OPENAI_API_KEY` deleted. Missing or not-runnable Codex emits `ok:false` JSON with a direct install/login diagnostic. Scratch preserved.
6. Spawn with `OPENAI_API_KEY` deleted. Stdout/stderr are piped and tailed. They are mirrored live to wrapper stderr only when `--stream-thinking && !--quiet`. Prompt via stdin.
7. On spawn failure → emit `ok:false` with `error: "failed to spawn codex: …"`. Scratch preserved.
8. On non-zero exit → emit `ok:false` with `error: "codex exited with code N. <common hint> Diagnostic tail: …"`. Scratch preserved.
9. On zero exit → read `<sessionDir>/last-message.txt`:
   - File missing → emit `ok:false`, "codex did not write a final message file at …". Scratch preserved.
   - Empty file → emit `ok:false`, "codex final message was empty". Scratch preserved.
   - Strip optional leading ` ```json ` fence and trailing ``` if present.
   - Try strict `JSON.parse`; on failure scan for the first balanced `{...}` block and parse that (with a warning if it works).
   - All extraction paths fail → emit `ok:false` describing the failure. Scratch preserved.
   - Root not an object → emit `ok:false`, "result root is not a JSON object". Scratch preserved.
10. `normalizeResult(parsed)` — validate/coerce `taskResult`; coerce missing/wrong-type `summary`/`details`/`files` to safe defaults with warnings; iterate `files`, coerce unknown action verbs to `"referenced"` with per-entry warnings; omit referenced entries unless `--track-references`.
11. Unless `--debug`: `rmSync(sessionDir, {recursive:true, force:true})`. Failures recorded as warnings, run still `ok:true`.
12. Emit JSON: `{ ok, taskResult, summary, details, files, workdir, sessionDir: null|<path>, model, permissions, warnings, durationMs }`. Also write to `--out` path if set. Exit 0 only for `taskResult:"completed"`.

### Manual permission matrix
`scripts/permission-matrix.mjs` is a manual harness, not part of `npm test`. It defaults to `../kva` but accepts `--target DIR`. It runs three tasks (read features, write `FEATURES.<run>.md` in workspace, write `FEATURES.<run>.md` to parent dir) against the three permission modes. Expected behavior: `read-only` only read succeeds; `workspace-write` read + workspace write succeed; `danger-full-access` all three succeed. Blocked cases now require wrapper `ok:false`, `taskResult:blocked|failed`, and no created file. It writes run artifacts under repo-local `tmp/permission-matrix/` and uses unique probe filenames so it does not overwrite a real `FEATURES.md`.

## Invariants
- A single run is always serial. Never spawn multiple codex children in parallel.
- Session dirs are unique per invocation: `<timestamp>-<pid>`.
- Session dirs live outside the user's workdir — always under `<os.tmpdir()>/codex-task/`.
- Stdout output is always a single valid JSON object — never partial, never interleaved with codex chatter, even on failure paths.
- The result schema's `files` map always uses allowed action verbs. Anything unknown is rewritten to `"referenced"` with a warning before emit, and omitted unless `--track-references`.
- The JSON always surfaces `model` and `permissions` — even on failure — so the caller can see what the wrapper actually asked codex to do.
- On `ok: true`, `taskResult:"completed"`, `summary` / `details` / `files` are present (possibly empty strings / empty object) and `sessionDir` is `null` (cleaned up) unless `--debug`.
- On `ok: false`, `sessionDir` is non-null and points at the preserved scratch dir.

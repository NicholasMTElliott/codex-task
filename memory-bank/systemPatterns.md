# systemPatterns

## Architecture
Single-process Node ESM script. No daemon, no state, no IPC beyond the spawned codex child. One subcommand: read prompt, build wrapper prompt, spawn codex, wait, read structured result file, emit JSON.

```
caller (Claude Code / opencode / shell)
   │  --prompt / --prompt-file
   │  --cwd / --out / --debug / --quiet
   ▼
codex-task.mjs
   │  parseArgs → resolve workdir → mkdir <workdir>/.codex-task-tmp/<sessionId>/
   │  buildPrompt (wrap user task with JSON-output instructions
   │               pointing at <sessionDir>/result.json)
   │  spawn('codex', ['exec','--full-auto','--skip-git-repo-check','--cd', workdir]),
   │     env without OPENAI_API_KEY, prompt via stdin
   │  codex stdout/stderr → user's stderr (live progress) unless --quiet
   ▼
codex CLI (ChatGPT-authed)
   │  reads/writes files inside workdir per workspace-write permission
   │  writes result.json to <sessionDir>/result.json
   ▼
readResult (strip ```json fences, JSON.parse) →
normalizeResult (coerce unknown action verbs to "referenced",
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
- **`--cd` to the user's workdir, not a sandbox.** Unlike `codex-image-gen` which sandboxes codex in a fresh tmp dir, `codex-task` deliberately points codex at the user's project (or a `--cwd` override). The whole point is for codex to perform work on the user's files. The blast radius is bounded by codex's `workspace-write` sandbox, which is in turn confined to the `--cd` target.
- **`--full-auto`.** Skips per-shell-command approval prompts so the workflow is hands-off. Trade-off: codex can't pause to ask questions. The parent agent must specify the task up-front.
- **`--skip-git-repo-check`.** Users will run this inside their own (often untrusted-to-codex) repos. We've already accepted `--full-auto`; skipping the trust prompt is consistent with that choice.
- **Posix-style path inside the prompt** (`replace(/\\/g, '/')`) — codex normalizes both, but forward slashes avoid backslash-escape ambiguity in tool-call parsing.
- **Tmp dir inside the workdir, not under `/tmp` or HOME.** Codex's `workspace-write` permission is confined to `--cd <workdir>`, so the result file must live inside that workdir. Path: `<workdir>/.codex-task-tmp/<sessionId>/result.json`. The tmp root is single-purpose and gitignore-able; on success we also try to remove the tmp root if it's now empty so we don't leave a stray dir.
- **Live codex output streams to *our* stderr.** Final JSON goes to stdout; codex's progress chatter goes to stderr so pipes that consume our stdout (e.g. `node codex-task.mjs … | jq .summary`) get exactly one valid JSON document. `--quiet` discards the stderr stream entirely (still captures a 4KB tail for failure reporting).
- **Markdown-fence stripping in the result file.** LLMs love to wrap "JSON files" in ` ```json ` fences despite explicit instructions. We strip a leading fence and trailing ``` before parsing — common-case lenience without sacrificing the strict-shape contract.
- **Unknown action verbs are demoted, not rejected.** If codex returns `"modified"` or `"updated"` for a file action, we coerce to `"referenced"` and emit a warning. Rationale: the wrapper's job is to give the parent agent a stable schema; rejecting the whole run because codex used a synonym would be hostile. The warning surfaces the issue for tightening prompts later.
- **Cleanup-on-success default.** On `ok && !--debug`, `rmSync(sessionDir, {recursive:true, force:true})` runs before emit. Failed runs preserve tmp unconditionally so the user can investigate. Cleanup failures are non-fatal — recorded as a warning, the run still reports `ok:true`.
- **Soft schema validation, not strict.** Missing `summary` / `details` / `files` → coerced to empty defaults with a warning, run still succeeds. Hard failures are reserved for: codex exiting non-zero, no result file written, result file not valid JSON, or root not an object.

## Component relationships

- `codex-task.mjs` — runtime. Pure: parse args → build wrapper prompt → spawn codex → read result file → normalize → emit JSON.
- `install.mjs` — multi-target installer. Verifies `node` + `codex` on PATH, copies the tool to `~/.codex-task/`, renders SKILL.md, then iterates a `TARGETS` registry to drop the rendered skill into each selected harness's user-global skills dir. For Claude Code, also idempotently patches `~/.claude/settings.json` `permissions.allow` with the `Bash(node <SCRIPT_PATH> *)` rule. Other harnesses are permissive by default and get no settings patch. The `agents` cross-harness target is `explicitOnly: true`. Flags: `--target=<csv>` / `--all` / `--no-<id>` / `--list-targets` / `--uninstall`.
- `SKILL.md` — Anthropic-style skill template (frontmatter: `name` + `description` + `allowed-tools`). Tells the agent when to invoke and what arguments to pass. Two placeholders (`<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>`) are rendered by the installer.

## Critical flows

### Install
Same `TARGETS` registry pattern as `codex-image-gen`. See `codex-image-gen/memory-bank/systemPatterns.md` for the full flow — only the install dir (`~/.codex-task/`) and skill subfolder name (`codex-task`) differ.

### Run
1. `parseArgs(process.argv.slice(2))` — resolve `--prompt` / `--prompt-file` (mutually exclusive; UTF-8 read with `.trim()`, empty-after-trim rejected); resolve `--cwd` (relative or absolute; defaults to caller cwd; must exist or exit 2); parse flags. `-h`/`--help` prints usage to stdout, exits 0.
2. Make `<workdir>/.codex-task-tmp/<sessionId>/` with `<sessionId>` = `<timestamp>-<pid>`. Pre-allocate the result-file path inside.
3. Build the wrapper prompt: fixed preamble explaining JSON shape + the user's task verbatim + the result-file path (posix-slash).
4. Spawn `codex exec --full-auto --skip-git-repo-check --cd <workdir>` with `OPENAI_API_KEY` deleted. Stdout/stderr inherit by default (live to user); `--quiet` switches stdout to ignore and stderr to a 4KB-capped pipe. Prompt via stdin.
5. On spawn failure → emit `ok:false` with `error: "failed to spawn codex: …"`. Tmp preserved.
6. On non-zero exit → emit `ok:false` with `error: "codex exited with code N. stderr tail: …"`. Tmp preserved. Stderr tail only available under `--quiet` (otherwise codex's output already went to the user's terminal).
7. On zero exit → read `<sessionDir>/result.json`:
   - File missing → emit `ok:false`, "result file not written by codex at …". Tmp preserved.
   - Read fails → emit `ok:false`, "failed to read result file: …". Tmp preserved.
   - Strip optional leading ` ```json ` fence and trailing ``` if present.
   - `JSON.parse` fails → emit `ok:false`, "result file is not valid JSON: …". Tmp preserved.
   - Root not an object → emit `ok:false`, "result file root is not a JSON object". Tmp preserved.
8. `normalizeResult(parsed)` — coerce missing/wrong-type `summary`/`details`/`files` to safe defaults with warnings; iterate `files`, coerce unknown action verbs to `"referenced"` with per-entry warnings.
9. Unless `--debug`: `rmSync(sessionDir, {recursive:true, force:true})`. Best-effort prune of `tmpRoot` if it's now empty. Failures recorded as warnings, run still `ok:true`.
10. Emit JSON: `{ ok, summary, details, files, workdir, sessionDir: null|<path>, warnings, durationMs }`. Also write to `--out` path if set. Exit 0.

## Invariants
- A single run is always serial. Never spawn multiple codex children in parallel.
- Session dirs are unique per invocation: `<timestamp>-<pid>`.
- Stdout output is always a single valid JSON object — never partial, never interleaved with codex chatter, even on failure paths.
- The result schema's `files` map always uses one of the four allowed action verbs. Anything else is rewritten to `"referenced"` with a warning before emit.
- On `ok: true`, `summary` / `details` / `files` are present (possibly empty strings / empty object) and `sessionDir` is `null` (cleaned up) unless `--debug`.
- On `ok: false`, `sessionDir` is non-null and points at the preserved tmp dir.

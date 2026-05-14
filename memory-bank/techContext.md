# techContext

## Stack
- **Runtime:** Node 18+ (uses `??`, `process.removeAllListeners`).
- **Language:** JavaScript ESM (`.mjs`). No TypeScript, no transpile step.
- **Std-lib only:** `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:url`. No `package.json` (besides a stub for `"type":"module"` discoverability — see Repo files), no npm deps.
- **External binary:** `codex` CLI on PATH, authenticated against a ChatGPT plan via `codex login`.
- **Companion project:** `codex-image-gen` (same author, same install patterns, same target registry approach).

## Constraints
- **Zero npm deps.** Adding any is a non-starter without explicit approval.
- **Single-file runtime.** The wrapper is one `.mjs`. Size may grow as long as it stays comprehensible.
- **Env hygiene.**
  - DELETE `OPENAI_API_KEY` from the spawned env (forces ChatGPT-subscription billing).
  - DO NOT override `CODEX_HOME` (codex auth lives there).
- **Serial-by-design.** No concurrent invocations; codex#11435 corrupts state under parallel sessions when `CODEX_HOME` is shared.
- **Windows quirks.**
  - `codex` installs as `codex.cmd` via npm. Spawning `.cmd` post-CVE-2024-27980 requires `shell:true` (else EINVAL).
  - `shell:true` triggers DEP0190 — suppressed via `process.removeAllListeners('warning')` and a filtered handler. Args are static + a path with no shell metachars, so this is safe here.
  - Under `shell:true`, Node concatenates argv without escaping → multi-word prompts split. Mitigated by piping the prompt via stdin instead of passing it as an argv positional.
- **Output sandbox.** `codex exec --cd <workdir>` is the primary write boundary, modulated by `--sandbox <mode>` (set from our `--permissions`). Under `read-only` (the default) codex can't write to the workdir at all; we use codex's `--add-dir <sessionDir>` to grant write access to *just* the wrapper's scratch dir, which lives outside the workdir under OS tmp. Under `workspace-write`, the workdir is also writable. `danger-full-access` removes all filesystem boundaries.
- **Stdout contract.** Our stdout is reserved for the final JSON result. Codex's own progress chatter flows to stderr (live, by default) so pipes consuming our stdout get exactly one valid JSON document. `--quiet` discards the stderr stream entirely except for a 4KB tail captured for failure reporting.

## Codex behaviors (empirical)
- **`--full-auto` is deprecated** in codex 0.128.0. Using it emits `warning: \`--full-auto\` is deprecated; use \`--sandbox workspace-write\` instead.` on stderr. The wrapper uses the explicit canonical form: `--sandbox <mode>`.
- **`--ask-for-approval` is NOT exposed on `codex exec`** in 0.128.0 — it's only on the top-level `codex` command. `codex exec` defaults approval to `never` automatically (visible as `approval: never` in the run header), and trying to pass `--ask-for-approval` to `exec` crashes with `unexpected argument`. The wrapper relies on this exec default rather than passing the flag.
- **`--sandbox` values** (codex 0.128.0): `read-only`, `workspace-write`, `danger-full-access`. The wrapper's `--permissions` maps to these plus a `full-auto` alias for `workspace-write`.
- **`--add-dir <DIR>` does NOT override `--sandbox read-only`.** Empirically verified: combining `--sandbox read-only` + `--add-dir <writable-scratch>` and asking the model to write a file into the scratch dir results in `patch rejected: writing is blocked by read-only sandbox`. `--add-dir` apparently extends the workspace under `workspace-write`, not as an override for `read-only`. So the wrapper does NOT use `--add-dir`; it captures the structured result via `--output-last-message` instead.
- **`-o, --output-last-message <FILE>`** writes the agent's FINAL message text to the given file. This is a codex CLI-process write (NOT a model write), so it bypasses `--sandbox` entirely. Empirically verified to work under `--sandbox read-only`. This is how the wrapper captures its structured result while keeping the model in a read-only sandbox.
- **`--ephemeral`** suppresses codex's session-file persistence. We pass it always because each wrapper invocation is a one-shot delegated task, not part of an interactive session worth resuming.
- **`--model` validation is server-side.** Unsupported values return HTTP 400 with `"<model> is not supported when using Codex with a ChatGPT account"`. No way to enumerate supported models from the CLI; the wrapper just lists common known names in `--help`.
- **`--search` is NOT exposed on `codex exec`** in 0.128.0. It exists on top-level `codex` (interactive) only. `codex features list` shows the related features (`web_search_request`, `web_search_cached`) as deprecated and `search_tool` as removed. Web search is not available in `codex exec` runs; the wrapper does not attempt to expose a `--search` flag because there is no underlying mechanism to map it to.
- **`--profile <NAME>`** loads option defaults from a named profile in `~/.codex/config.toml`. Pass-through only — we don't validate the name, codex errors out if it doesn't exist.
- **Final-message JSON from the model.** When instructed clearly, the model emits its structured JSON as the final message text and codex captures it via `--output-last-message`. The model occasionally wraps the JSON in markdown fences ( ```json … ``` ) or adds prose around it; the wrapper strips a leading fence + trailing ``` and, on parse failure, falls back to extracting the first balanced `{...}` block (depth-aware, quote-aware scan).
- **Action verb hygiene.** Codex sometimes uses synonyms like `"modified"`, `"updated"`, or `"removed"` instead of the requested `"edited"` / `"deleted"`. The wrapper coerces unknown verbs to `"referenced"` and warns — re-wording the prompt rarely helps universally, so we tolerate it at the boundary.
- **Stdout chatter.** Codex's stdout under `exec` is verbose by design (reasoning traces, tool calls, partial outputs). Streaming it live to *our* stderr means the user can follow progress without it polluting our JSON stdout.
- **Trusted-dir guard.** Without `--skip-git-repo-check`, codex refuses to operate inside a directory it doesn't recognize as trusted. We always pass `--skip-git-repo-check` because users will invoke `codex-task` against their own projects (which codex has no way to know about), and we've already accepted hands-off operation.

## Setup
```bash
git clone https://github.com/NicholasMTElliott/codex-task.git    # placeholder URL
cd codex-task
node install.mjs                                          # install (auto-detect targets)
node install.mjs --target=claude,opencode,cline,cursor    # explicit targets
node install.mjs --all                                    # install to every known target (incl. agents)
node install.mjs --no-opencode                            # exclude target from default set
node install.mjs --target=agents                          # only the cross-harness agents target
node install.mjs --list-targets                           # show targets + detection state
node install.mjs --uninstall                              # remove tool + every target's skill dir
```
Installer paths (per-target; the binary is shared):
- Tool (shared): `~/.codex-task/codex-task.mjs`
- Claude Code: skill at `~/.claude/skills/codex-task/SKILL.md`; settings patch in `~/.claude/settings.json` → `permissions.allow` += `Bash(node <SCRIPT_PATH> *)`.
- opencode: skill at `~/.config/opencode/skills/codex-task/SKILL.md`. No settings patch — opencode is permissive by default.
- Cline: skill at `~/.cline/skills/codex-task/SKILL.md`. No settings patch.
- Cursor: skill at `~/.cursor/skills/codex-task/SKILL.md`. No settings patch. Cursor also reads `~/.claude/skills/` and `~/.codex/skills/` as compatibility paths.
- Agents (`explicitOnly`, never auto-installed): skill at `~/.agents/skills/codex-task/SKILL.md`. Cross-harness shared dir read by Cursor + opencode. Auto-installing would duplicate entries; user must opt in via `--target=agents` or `--all`.

## Dependencies (tree)
- Required at runtime: `node` ≥ 18, `codex` CLI on PATH, ChatGPT auth (`codex login`).
- Optional (any one suffices for auto-invocation): a coding-agent harness that reads SKILL.md — Claude Code, opencode, Cline, Cursor, or any other target the installer registers with.

## Tooling patterns
- **CLI shape:** single mode, no subcommand. Required: a prompt via inline `--prompt` or from a file `--prompt-file` (UTF-8, `.trim()`-applied, mutually exclusive, empty-after-trim rejected). Optional: `--cwd` (relative or absolute; must exist), `--out` (write JSON to this path in addition to stdout), `--debug` (preserve scratch on success), `--quiet` (discard codex live output), `--model <NAME>` (default `gpt-5.5`; verbatim pass-through), `--permissions <MODE>` (default `read-only`; one of `read-only|workspace-write|full-auto|danger-full-access`), `--profile <NAME>` (optional pass-through). `-h`/`--help` prints usage to stdout and exits 0 (POSIX — pipeable). Usage-due-to-error (missing required arg, unknown arg, --cwd missing, unreadable/empty prompt file, invalid permissions value) prints to stderr and exits 2.
- **Output contract:** JSON on stdout via `emit()`. Always the same shape: `ok`, `summary`, `details`, `files`, `workdir`, `sessionDir`, `model`, `permissions`, `warnings`, `durationMs`; `error` added on failure. Exit code 0 iff `ok`; 2 for argparse errors; 1 for runtime failures.
- **Error model:** all failure paths route through `emit(..., 1|2, args.out)` with a populated `error` and `sessionDir` preserved when applicable. No partial JSON, no half-written stdout. The `--out` file gets the same content as stdout on every exit path.
- **Result capture mechanism:** codex's `--output-last-message <sessionDir>/last-message.txt`. The codex CLI process (not the model) writes the agent's final message text to this file *after* the agent exits — wrapper-process write, NOT subject to `--sandbox`. The scratch dir lives at `<os.tmpdir()>/codex-task/<sessionId>/` (outside the workdir, so the project is never polluted).
- **Prompt synthesis:** fixed preamble (explaining the JSON shape the agent's FINAL MESSAGE must take) → user prompt verbatim → optional `read-only` addendum (telling codex to describe edits in `details` rather than fail on writes). No file paths in the prompt — codex captures the message itself via `--output-last-message`.
- **Result lenience:** strip a leading ` ```json `/` ``` ` fence and trailing ``` before parsing. Strict JSON.parse first. On failure, scan for the first balanced `{...}` block (depth + JSON-string-quote aware) and parse that — emits a warning when this fallback fires. Coerce unknown action verbs (`"modified"` etc.) to `"referenced"` with warnings rather than failing the run.
- **Session dir naming:** `<timestamp>-<pid>` under `<os.tmpdir()>/codex-task/`. Removed on success unless `--debug`.
- **Cleanup contract:** on `ok && !--debug`, `rmSync(sessionDir, {recursive:true, force:true})`. Failures preserve scratch unconditionally. Cleanup errors emit a warning but do not flip `ok` to false.
- **Permissions → sandbox mapping** (table in `PERMISSIONS` constant): `read-only` → `--sandbox read-only`; `workspace-write` → `--sandbox workspace-write`; `full-auto` → `--sandbox workspace-write` (alias); `danger-full-access` → `--sandbox danger-full-access`. Approval is always `never` regardless.
- **Settings patcher (`install.mjs`):** idempotent — re-runs are no-ops; tolerates missing/malformed settings.json by printing the rule instead of crashing. Per-target — currently only the Claude target needs it.
- **Multi-target install (`install.mjs`):** owns a `TARGETS` registry (`{id, label, skillDir, settingsPath, detectPath, defaultOn, explicitOnly?}`). Resolution: `--target=<csv>` overrides everything; else `--all` selects every target (including `explicitOnly` ones); else default = every target where `!explicitOnly && (defaultOn || detectPath exists)`; `--no-<id>` removes from the resulting set. `--list-targets` prints state and exits.

## Repo files (entry points)
- `codex-task.mjs` — runtime tool (executable, shebang `node`).
- `install.mjs` — installer (executable, shebang `node`).
- `SKILL.md` — skill template with `<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>` placeholders.
- `README.md` — user-facing docs.
- `AGENTS.md` / `CLAUDE.md` — agent-facing instructions; CLAUDE.md is a one-line `@AGENTS.md` re-export.
- `.gitignore` — standard Node / OS-noise ignores. The wrapper does not write into the project directory, so no project-specific entries are needed.
- `LICENSE` — MIT.
- `package.json` — stub with `"type": "module"`. Not required for execution (the `.mjs` extension is enough) but useful for editor/tooling integration.

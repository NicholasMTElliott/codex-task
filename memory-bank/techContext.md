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
- **Output sandbox.** `codex exec --cd <workdir>` confines codex's `workspace-write` permission to that dir. The result file path passed to codex must live inside that workdir (we put it under `<workdir>/.codex-task-tmp/<sessionId>/`).
- **Stdout contract.** Our stdout is reserved for the final JSON result. Codex's own progress chatter flows to stderr (live, by default) so pipes consuming our stdout get exactly one valid JSON document. `--quiet` discards the stderr stream entirely except for a 4KB tail captured for failure reporting.

## Codex behaviors (empirical)
- **`codex exec --full-auto`.** Skips per-shell-command approval prompts. Codex's `workspace-write` permission is still in effect — confined to the `--cd` target. No filesystem-wide write access.
- **File writes from inside the prompt.** Codex reliably writes a single result file to a specific path when instructed in the prompt. It occasionally wraps the file contents in markdown fences ( ```json … ``` ) despite explicit instructions; we strip a leading fence + trailing ``` before parsing.
- **Action verb hygiene.** Codex sometimes uses synonyms like `"modified"`, `"updated"`, or `"removed"` instead of the requested `"edited"` / `"deleted"`. The wrapper coerces unknown verbs to `"referenced"` and warns — re-wording the prompt rarely helps universally, so we tolerate it at the boundary.
- **Stdout chatter.** Codex's stdout under `exec` is verbose by design (reasoning traces, tool calls, partial outputs). Streaming it live to *our* stderr means the user can follow progress without it polluting our JSON stdout.
- **Trusted-dir guard.** Without `--skip-git-repo-check`, codex refuses to operate inside a directory it doesn't recognize as trusted. We always pass `--skip-git-repo-check` because users will invoke `codex-task` against their own projects (which codex has no way to know about), and we've already accepted `--full-auto` for hands-off operation.

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
- **CLI shape:** single mode, no subcommand. Required: a prompt via inline `--prompt` or from a file `--prompt-file` (UTF-8, `.trim()`-applied, mutually exclusive, empty-after-trim rejected). Optional: `--cwd` (relative or absolute; must exist), `--out` (write JSON to this path in addition to stdout), `--debug` (preserve tmp on success), `--quiet` (discard codex live output). `-h`/`--help` prints usage to stdout and exits 0 (POSIX — pipeable). Usage-due-to-error (missing required arg, unknown arg, --cwd missing, unreadable/empty prompt file) prints to stderr and exits 2.
- **Output contract:** JSON on stdout via `emit()`. Always the same shape: `ok`, `summary`, `details`, `files`, `workdir`, `sessionDir`, `warnings`, `durationMs`; `error` added on failure. Exit code 0 iff `ok`; 2 for argparse errors; 1 for runtime failures.
- **Error model:** all failure paths route through `emit(..., 1|2, args.out)` with a populated `error` and `sessionDir` preserved when applicable. No partial JSON, no half-written stdout. The `--out` file gets the same content as stdout on every exit path.
- **Result file path:** `<workdir>/.codex-task-tmp/<sessionId>/result.json`. Inside the workdir so codex's `workspace-write` sandbox covers it. Gitignore-able as `.codex-task-tmp/`.
- **Prompt synthesis:** fixed preamble (explaining JSON shape + path) → user prompt verbatim → result-file-path footer. Posix-slash paths in the prompt.
- **Result lenience:** strip a leading ` ```json `/` ``` ` fence and trailing ``` before parsing, since LLMs often wrap "JSON files" this way despite explicit instructions. Strict JSON.parse after that. Coerce unknown action verbs (`"modified"` etc.) to `"referenced"` with warnings rather than failing the run.
- **Session dir naming:** `<timestamp>-<pid>` under `<workdir>/.codex-task-tmp/` (ephemeral). Removed on success unless `--debug`; on success we also try to remove the tmp root if it's now empty.
- **Cleanup contract:** on `ok && !--debug`, `rmSync(sessionDir, {recursive:true, force:true})`. Failures preserve tmp unconditionally. Cleanup errors emit a warning but do not flip `ok` to false.
- **Settings patcher (`install.mjs`):** idempotent — re-runs are no-ops; tolerates missing/malformed settings.json by printing the rule instead of crashing. Per-target — currently only the Claude target needs it.
- **Multi-target install (`install.mjs`):** owns a `TARGETS` registry (`{id, label, skillDir, settingsPath, detectPath, defaultOn, explicitOnly?}`). Resolution: `--target=<csv>` overrides everything; else `--all` selects every target (including `explicitOnly` ones); else default = every target where `!explicitOnly && (defaultOn || detectPath exists)`; `--no-<id>` removes from the resulting set. `--list-targets` prints state and exits.

## Repo files (entry points)
- `codex-task.mjs` — runtime tool (executable, shebang `node`).
- `install.mjs` — installer (executable, shebang `node`).
- `SKILL.md` — skill template with `<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>` placeholders.
- `README.md` — user-facing docs.
- `AGENTS.md` / `CLAUDE.md` — agent-facing instructions; CLAUDE.md is a one-line `@AGENTS.md` re-export.
- `.gitignore` — pre-includes `.codex-task-tmp/`.
- `LICENSE` — MIT.
- `package.json` — stub with `"type": "module"`. Not required for execution (the `.mjs` extension is enough) but useful for editor/tooling integration.

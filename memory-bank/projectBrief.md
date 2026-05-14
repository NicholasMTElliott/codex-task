# projectBrief

## Purpose
Portable Node CLI tool that lets Claude Code, opencode, Cline, Cursor, or any other coding-agent harness delegate a self-contained coding task to OpenAI's `codex` CLI and receive a structured JSON result describing what was done. Routes billing through the user's ChatGPT subscription instead of API tokens. Companion to `codex-image-gen` (same install/distribution patterns, different runtime payload).

## Scope
- One ESM entry point: `codex-task.mjs`.
- Single subcommand (no dispatch): a `--prompt` (or `--prompt-file`) describes the task; the tool wraps that prompt with structured-output instructions and runs it through `codex exec`.
- Cross-platform installer: `install.mjs`. Copies tool to `~/.codex-task/` and registers the rendered SKILL.md with each detected coding-agent harness via a `TARGETS` registry. Current targets: **Claude Code** (`~/.claude/skills/codex-task/SKILL.md` + `permissions.allow` patch in `~/.claude/settings.json`), **opencode** (`~/.config/opencode/skills/codex-task/SKILL.md`; no settings patch — opencode is permissive by default), **Cline** (`~/.cline/skills/codex-task/SKILL.md`), **Cursor** (`~/.cursor/skills/codex-task/SKILL.md`), and **agents** (`~/.agents/skills/codex-task/SKILL.md`; cross-harness shared dir read by Cursor + opencode — `explicitOnly: true`, never auto-installed even when its detect path exists). Flags: `--target=<csv>` / `--all` / `--no-<id>` / `--list-targets` / `--uninstall`. Adding a harness = one entry in the `TARGETS` array plus a test case.
- Skill template: `SKILL.md` (Anthropic-style frontmatter — `name` + `description` + `allowed-tools`; placeholders `<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>` rendered at install). Same rendered file is dropped into every target's skills dir; harnesses that don't recognize a field silently ignore it.
- Zero npm dependencies. Node 18+ only.
- Serial-by-design (no concurrent invocation).
- One persistent on-disk artifact per session: a tmp dir under the workdir at `<workdir>/.codex-task-tmp/<sessionId>/`. Auto-cleaned on success (unless `--debug`); preserved on failure. There is no equivalent of codex-image-gen's persistent output dir — the "output" of a codex-task run is the structured JSON on stdout plus whatever files codex created/edited in the workdir itself.

## Out of scope
- Continuous / multi-turn sessions with a single codex instance. Each invocation spawns a fresh `codex exec`.
- Interactive tasks that need to pause and ask the user a question. `codex exec --full-auto` is hands-off by design.
- Network/credential plumbing beyond what codex already has. The wrapper doesn't inject env vars beyond stripping `OPENAI_API_KEY`.
- Concurrent / parallel invocation.
- Bundling, transpiling, or any build step.

## Requirements
- Must NOT use `OPENAI_API_KEY` — deletes it from spawned env so codex routes to ChatGPT subscription billing.
- Must NOT override `CODEX_HOME` — codex stores ChatGPT auth there.
- Must work on Windows + macOS + Linux. Windows requires `shell:true` for spawning `codex.cmd`.
- Must keep zero-dep, single-file properties when changes are proposed.
- Final stdout output MUST be a single valid JSON object — never partial or interleaved. Codex's own log output streams to stderr by default so it doesn't corrupt stdout for piping callers.

## Distribution
GitHub: TBD (parallel to `codex-image-gen` — same author, same MIT license).

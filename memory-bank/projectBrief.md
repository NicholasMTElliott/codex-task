# projectBrief

## Purpose
Portable Node CLI tool that lets Claude Code, opencode, Cline, Cursor, or any other coding-agent harness delegate a self-contained writing, summarization, investigation, or explicitly requested implementation task to OpenAI's `codex` CLI and receive a structured JSON result describing what was done. Routes billing through the user's ChatGPT subscription instead of API tokens. Primary skill use is proactive technical/creative writing: documentation drafts, README/release notes/changelogs, codebase feature summaries, narrative cleanup, and prose-heavy analysis. Coding/code execution is supported but should generally be delegated only when specifically requested or clearly required by the brief. Companion to `codex-image-gen` (same install/distribution patterns, different runtime payload).

## Scope
- One ESM entry point: `codex-task.mjs`.
- Single subcommand (no dispatch): a `--prompt` (or `--prompt-file`) describes the task; the tool wraps that prompt with structured-output instructions (`taskResult`, summary, details, files) and runs it through `codex exec`.
- Codex pass-throughs exposed as wrapper flags: `--model` (default `gpt-5.5`; common hints include `gpt-5.5`, `gpt-5.5-codex`, `gpt-5`, `gpt-5-codex`, and GPT-5.6 tiers `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna`), `--reasoning-effort` (optional pass-through to `-c model_reasoning_effort=<level>`; server-validated, model-dependent), `--permissions` (default `read-only`; values map directly to codex's supported `--sandbox` values: `read-only` / `workspace-write` / `danger-full-access`), `--profile` (optional pass-through to codex's `--profile`). The wrapper always passes `--ephemeral` (each delegation is one-shot, not part of a persisted session) and captures the agent's final message via codex's `--output-last-message`. Approval defaults to `never` automatically in `codex exec` (and `--ask-for-approval` is not exposed on the exec subcommand). The deprecated `full-auto` wrapper permission is intentionally not accepted.
- Codex flags NOT exposed: `--search` (not needed by wrapper; `codex exec` can perform web search when the prompt explicitly asks for current web research). `--ask-for-approval` (top-level only; exec defaults to `never`).
- Cross-platform installer: `install.mjs`. Copies tool to `~/.codex-task/` and registers the rendered SKILL.md with each detected coding-agent harness via a `TARGETS` registry. Current targets: **Claude Code** (`~/.claude/skills/codex-task/SKILL.md` + `permissions.allow` patch in `~/.claude/settings.json`), **opencode** (`~/.config/opencode/skills/codex-task/SKILL.md`; no settings patch — opencode is permissive by default), **Cline** (`~/.cline/skills/codex-task/SKILL.md`), **Cursor** (`~/.cursor/skills/codex-task/SKILL.md`), and **agents** (`~/.agents/skills/codex-task/SKILL.md`; cross-harness shared dir read by Cursor + opencode — `explicitOnly: true`, never auto-installed even when its detect path exists). Flags: `--target=<csv>` / `--all` / `--no-<id>` / `--list-targets` / `--uninstall`. Adding a harness = one entry in the `TARGETS` array plus a test case.
- Skill template: `SKILL.md` (Anthropic-style frontmatter — `name` + `description` + `allowed-tools`; placeholders `<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>` rendered at install). Same rendered file is dropped into every target's skills dir; harnesses that don't recognize a field silently ignore it.
- Zero npm dependencies. Node 18+ only.
- Serial-by-design (no concurrent invocation).
- One persistent on-disk artifact per session: a scratch dir under the OS temp directory at `<os.tmpdir()>/codex-task/<sessionId>/`. Lives OUTSIDE the user's workdir so the project is never polluted with a wrapper-owned folder. Contains a single file `last-message.txt` written by codex's CLI process (via `--output-last-message`) — this is a wrapper-process write, NOT a model-driven write, so it works under any `--sandbox` policy including `read-only`. Auto-cleaned on success (unless `--debug`); preserved on failure. There is no equivalent of codex-image-gen's persistent output dir — the "output" of a codex-task run is the structured JSON on stdout plus whatever files codex created/edited in the workdir itself (under modes that allow writes). Referenced files are omitted unless `--track-references` is passed.

## Out of scope
- Continuous / multi-turn sessions with a single codex instance. Each invocation spawns a fresh `codex exec`.
- Interactive tasks that need to pause and ask the user a question. `codex exec` is hands-off here because approval defaults to `never`.
- Network/credential plumbing beyond what codex already has. The wrapper doesn't inject env vars beyond stripping `OPENAI_API_KEY`.
- Concurrent / parallel invocation.
- Bundling, transpiling, or any build step.

## Requirements
- Must NOT use `OPENAI_API_KEY` — deletes it from spawned env so codex routes to ChatGPT subscription billing.
- Must NOT override `CODEX_HOME` — codex stores ChatGPT auth there.
- Must work on Windows + macOS + Linux. Windows requires `shell:true` for spawning `codex.cmd`.
- Must keep zero-dep, single-file properties when changes are proposed.
- Final stdout output MUST be a single valid JSON object — never partial or interleaved. Codex's own log/thinking output is captured silently by default; `--stream-thinking` mirrors it to stderr for humans without corrupting stdout.
- Must preflight `codex --version` before a run and return structured JSON when the Codex CLI is missing or not runnable. Non-zero `codex exec` exits include a captured diagnostic tail plus hints for common auth, quota, model, reasoning effort, and sandbox failures.

## Distribution
GitHub: `https://github.com/NicholasMTElliott/codex-task`. Default branch policy: `mainline`. MIT licensed. Public package metadata lives in `package.json` (`repository`, `bugs`, `homepage`, `keywords`, `bin`).

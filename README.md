# codex-task

A small portable tool that lets Claude Code, opencode, Cline, Cursor, or any CLI coding agent **delegate a self-contained coding task to OpenAI's `codex` CLI and get back a structured JSON result** — billed against the user's ChatGPT subscription, not the API.

Companion to [`codex-image-gen`](https://github.com/NicholasMTElliott/codex-image-gen): same installer patterns, same target registry approach, different runtime payload.

Single mode: feed it a `--prompt` (or `--prompt-file`), it runs `codex exec --full-auto` against your project, and emits JSON like:

```json
{
  "ok": true,
  "summary": "Renamed getCwd to getCurrentWorkingDirectory across 8 files; updated 3 tests.",
  "details": "Searched the repo for all occurrences of `getCwd` (15 hits). Renamed the function and call sites, updated import names, and adjusted the 3 tests that asserted on the old name. One TODO comment in `src/legacy.js` references the old name; left as-is since it's purely informational.",
  "files": {
    "src/utils/paths.js": "edited",
    "src/server/routes.js": "edited",
    "tests/paths.test.js": "edited",
    "src/legacy.js": "referenced"
  },
  "workdir": "/abs/path/to/project",
  "sessionDir": null,
  "warnings": [],
  "durationMs": 84210
}
```

Action values for each touched file are one of `created`, `deleted`, `edited`, or `referenced`. The parent agent (Claude Code etc.) can use this to audit what changed without reading codex's full transcript.

Ships with an Anthropic-style `SKILL.md` that the installer registers with each detected coding-agent harness (Claude Code, opencode, Cline, Cursor, …) so the agent knows when and how to invoke it.

## Why

When you're running on a Claude (or other paid) subscription and want to delegate a chunk of agent work — a multi-file refactor, scaffolding pass, exploratory investigation — to a fresh codex context, paying for that delegation in API tokens stings. `codex exec` against an authed ChatGPT plan bills the work to the user's existing subscription quota. This tool wraps `codex exec` with the right flags, environment, and prompt template so the delegating agent can call it without thinking about the gotchas — and gets back a stable JSON contract for what changed.

## What's in this directory

| File | Purpose |
|------|---------|
| `codex-task.mjs` | The tool. Plain Node ESM, no npm dependencies. |
| `install.mjs` | Cross-platform installer. Copies the tool to `~/.codex-task/` and registers the skill with each supported harness (Claude Code, opencode, Cline, Cursor). |
| `SKILL.md` | Skill template (Anthropic frontmatter — `name` + `description` + `allowed-tools`). The installer fills in the resolved install path and drops the same rendered file into every target's user-global skills dir. |
| `memory-bank/` | LLM-optimized project context (projectBrief, productContext, systemPatterns, techContext). |
| `README.md` | This file. |

## Prerequisites

1. **Node 18+** on `PATH`.
2. **`codex` CLI** on `PATH`, authed against a ChatGPT plan.
   - Install: see https://github.com/openai/codex for the current canonical install command on your platform.
   - Auth: `codex login` (uses ChatGPT account; opens a browser for OAuth).
3. **A paid ChatGPT plan** (Plus, Pro, or Team) if you want to avoid burning API tokens. The free tier may not include `codex exec` quota; check current ChatGPT terms.
4. **A coding-agent harness** that reads SKILL.md (only needed if you want the skill auto-invoked from inside an agent). The installer detects and registers with whichever of these are present:
   - **Claude Code** — skill at `~/.claude/skills/codex-task/SKILL.md`, with a matching `Bash(...)` allow rule auto-patched into `~/.claude/settings.json`.
   - **opencode** — skill at `~/.config/opencode/skills/codex-task/SKILL.md`. opencode permits external commands by default, so no settings patch is needed.
   - **Cline** — skill at `~/.cline/skills/codex-task/SKILL.md` ([Cline's user-global Skills system](https://docs.cline.bot/customization/skills)). No settings patch is needed.
   - **Cursor** — skill at `~/.cursor/skills/codex-task/SKILL.md` ([Cursor's Skills system](https://cursor.com/docs/skills)). No settings patch is needed. (Cursor also reads `~/.claude/skills/` and `~/.codex/skills/` as compatibility paths.)
   - The installer always installs the skill for Claude Code (it's the historical default — most users running this installer have Claude Code) and adds opencode / Cline / Cursor opportunistically when their config dirs exist. Use `--target=` / `--all` / `--no-<id>` to override (see below).
   - **Explicit-only target** — the installer also knows about `~/.agents/skills/`, a cross-harness shared dir read by Cursor and opencode. It is **never auto-installed** (would duplicate the per-harness installs into harnesses that read both paths). Pass `--target=agents` to use it intentionally, typically alongside `--no-cursor --no-opencode` to dedupe.

`codex` routes to subscription billing only when `OPENAI_API_KEY` is **not set** in the environment. The wrapper deletes that variable before spawning codex, so the user's shell can have the API key set for other purposes without breaking subscription routing for this tool.

## Install

```bash
git clone https://github.com/NicholasMTElliott/codex-task.git    # placeholder URL
cd codex-task
node install.mjs
```

### What the installer does

1. Verifies `node` and `codex` are on `PATH`.
2. Copies `codex-task.mjs` and `README.md` to `~/.codex-task/` (shared across all harnesses).
3. Renders `SKILL.md` with the absolute install path baked in.
4. For each selected target harness, drops the rendered SKILL.md into the harness's user-global skills dir:
   - `~/.claude/skills/codex-task/SKILL.md` (Claude Code)
   - `~/.config/opencode/skills/codex-task/SKILL.md` (opencode)
   - `~/.cline/skills/codex-task/SKILL.md` (Cline)
   - `~/.cursor/skills/codex-task/SKILL.md` (Cursor)
   - `~/.agents/skills/codex-task/SKILL.md` (cross-harness — explicit-only)
5. For Claude Code, also auto-patches the `permissions.allow` array in `~/.claude/settings.json` with the `Bash(...)` rule that pre-approves the tool. Idempotent — safe to re-run; falls back to printing the rule if `settings.json` is malformed. opencode, Cline, and Cursor are permissive by default and get no settings patch.

### Installer flags

| Flag | Effect |
|------|--------|
| (none) | Auto-detect: install to Claude Code (always) plus any other detected harness. |
| `--target=claude,opencode,cline,cursor` | Explicit list. Overrides detection — installs to exactly these targets, even if undetected. The only way to install the `agents` target without `--all`. |
| `--all` | Install to every known target regardless of detection, including `agents`. May produce duplicate entries in harnesses that read both their per-harness path and `~/.agents/skills/`; pair with `--no-cursor --no-opencode` if you want `agents` to be the canonical location. |
| `--no-<id>` | Exclude a target from the default set, e.g. `--no-opencode`. Combinable. |
| `--list-targets` | Print the target table with detection state and exit without installing. |
| `--uninstall` | Remove the install dir plus every known target's skill dir. Settings files are left alone — remove allow rules manually if you want them gone. |

To remove:

```bash
node install.mjs --uninstall
```

## Manual invocation

POSIX (bash/zsh):

```bash
node ~/.codex-task/codex-task.mjs \
  --prompt "Rename getCwd to getCurrentWorkingDirectory across the repo, including tests."
```

With a long brief from a file:

```bash
node ~/.codex-task/codex-task.mjs \
  --prompt-file ./refactor-brief.md \
  --cwd path/to/project \
  --out /tmp/refactor-result.json
```

Windows PowerShell — `~` does not expand in arguments, use `$env:USERPROFILE`:

```powershell
node "$env:USERPROFILE\.codex-task\codex-task.mjs" `
  --prompt "Rename getCwd to getCurrentWorkingDirectory across the repo, including tests."
```

Output is JSON on stdout. Codex's own progress chatter streams live to stderr by default so you can follow what it's doing; pass `--quiet` to suppress that stream. The interim per-session work dir under `<workdir>/.codex-task-tmp/<sessionId>/` is removed automatically on success — pass `--debug` to keep it, and failures always preserve it for debugging.

### Parameters

- `--prompt` (required if `--prompt-file` not given). Inline task description. Anything you'd tell codex to do.
- `--prompt-file` (required if `--prompt` not given; mutually exclusive with `--prompt`). Path to a UTF-8 text file containing the task description. Use for long multi-line briefs that don't shell-escape cleanly. Trailing whitespace trimmed; internal newlines preserved.
- `--cwd` (optional). Working directory codex operates inside (relative to caller cwd, or absolute). Default: caller cwd. Codex's `workspace-write` permission is confined to this directory — bounds the blast radius of the task.
- `--out` (optional). Also write the result JSON to this file path (still printed to stdout). Useful for piping or persistence.
- `--debug` (optional flag). Keep the per-session tmp dir on success. Default cleans it up to minimize disk impact. Failed runs always preserve tmp regardless.
- `--quiet` (optional flag). Discard codex's live log output instead of streaming it to stderr.

### Output JSON shape

```json
{
  "ok": true,
  "summary":    "<one or two sentences>",
  "details":    "<markdown>",
  "files":      { "<path>": "created|deleted|edited|referenced", ... },
  "workdir":    "<absolute --cwd>",
  "sessionDir": null,
  "warnings":   [],
  "durationMs": 12345
}
```

`ok` is `true` only when codex exits cleanly AND produces a parseable result file with a non-null root object. On `false`, an additional `error` field is populated, and `sessionDir` is preserved so you can inspect codex's interim output.

`files` action values are one of:

- `created` — file did not exist before; codex created it.
- `deleted` — file existed before; codex removed it.
- `edited` — file existed before; codex modified its contents.
- `referenced` — codex read the file as context but did not change it.

If codex returns an unknown action verb (`"modified"`, `"updated"`, etc.), the wrapper coerces it to `"referenced"` and emits a warning rather than failing the run.

Inspect `warnings` for non-fatal anomalies: unknown action verbs, missing schema fields, cleanup failures.

## Using it from a coding-agent harness

Once installed, **restart your agent** if it was already running — most harnesses load skills and settings only at startup. After that, just ask for a delegatable task in any project; the parent agent reads the skill description, decides it matches your request, and runs the tool for you.

Example dialogue (Claude Code):

> **You:** I want to rename `getCwd` to `getCurrentWorkingDirectory` everywhere it appears in this repo, including tests. Use codex-task — I'd rather not burn this conversation on it.
>
> **Claude:** *(invokes `node ~/.codex-task/codex-task.mjs --prompt "Rename getCwd to getCurrentWorkingDirectory across this repo. Update every call site, every import, every test. Do not change anything else."`, waits ~60s while codex's progress streams to the terminal, then reads the JSON and surfaces the `summary` + `files` to you)*

The same rendered `SKILL.md` is dropped into every target harness's skills dir, so the experience is identical from Claude Code, opencode, Cline, Cursor, or any other harness that reads Anthropic-style skill frontmatter (`name` + `description`). Harnesses that don't recognize the `allowed-tools` field simply ignore it.

### Other coding-agent harnesses (not auto-registered)

For harnesses without a user-global Skills system, register the tool manually per project — paste a short "Delegation tool available at: `~/.codex-task/codex-task.mjs`" block into your project-root `AGENTS.md`. The installer does **not** modify `AGENTS.md` automatically because it's typically checked in alongside the project and editing it without consent would be invasive.

If your harness has a stable user-global skills directory and you'd like first-class support, please open an issue — adding a target is a single entry in the `TARGETS` registry in [install.mjs](install.mjs).

## Updating

```bash
cd codex-task
git pull
node install.mjs
```

The installer is idempotent: re-running overwrites the installed copy in `~/.codex-task/`, re-renders the skill into every selected target's skills dir, and detects existing allow rules without duplicating them.

## Troubleshooting

1. **Manual smoke test** — isolates Node/codex issues from harness issues:
   ```bash
   node ~/.codex-task/codex-task.mjs --help
   node ~/.codex-task/codex-task.mjs --prompt "List every .md file in this directory and summarize what each one is about."
   ```
   If this fails, the problem is upstream of your agent harness (auth, quota, codex install).

2. **Auth failure** (401 / "Missing bearer or basic authentication") — your codex ChatGPT session expired. Run `codex login` again.

3. **Quota exhausted** — codex returns a quota error. Wait for the 5-hour rolling window to reset, or upgrade your ChatGPT plan.

4. **`error: "result file not written by codex…"`** — codex finished cleanly but didn't produce the structured result file. Probably the prompt confused it (e.g. you asked an open-ended question that codex answered conversationally without performing any task). Re-run with a clearer brief, or pass `--debug` and inspect `sessionDir` to see codex's actual output.

5. **Skill not auto-invoked from your agent** — verify install state with `node install.mjs --list-targets`, then for each detected harness check the skill file exists and contains an absolute path (no `<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>` placeholders left). **Restart the agent** if it was running when you installed.

6. **Worried about accidental API billing** — the wrapper strips `OPENAI_API_KEY` from the spawned env before invoking codex, so subscription routing is locked in regardless of what your shell has set.

## Cost & timing

- Time scales with task scope. Trivial codebase questions: ~15-30s. Multi-file refactors: 1-5 minutes. Long investigations: 5+ minutes.
- Quota: text-only tasks burn ChatGPT subscription quota at the normal text rate (5-hour rolling cap + weekly cap). Plan accordingly for batch use.
- The wrapper is serial-by-design. Do not invoke it in parallel — codex's session-state handling corrupts under concurrent `CODEX_HOME` use.

## Design notes

- **Why no npm deps**: keeps install trivial. Just `node install.mjs`. No `node_modules`, no version pinning, no transitive supply chain.
- **Why we delete `OPENAI_API_KEY`**: codex routes to API billing if it sees that variable, silently. We force subscription routing by stripping it from the spawned env.
- **Why we don't override `CODEX_HOME`**: codex stores its ChatGPT auth there. Override → fresh-install state → no auth → 401.
- **Why prompt is piped via stdin**: `codex exec` accepts the prompt as a positional arg, but on Windows with `shell:true` (required to spawn `codex.cmd` post-CVE-2024-27980) Node concatenates args without escaping, so a multi-word prompt gets split. Stdin sidesteps the issue.
- **Why `--full-auto`**: skips codex's per-shell-command approval prompts so the workflow is hands-off. Trade-off: codex can't pause to ask questions, so the parent agent must specify the task up-front.
- **Why `--cd` to the user's workdir, not a sandbox**: unlike `codex-image-gen` (which sandboxes codex in a fresh tmp dir for image generation), `codex-task` deliberately points codex at the user's project. The whole point is to perform work on the user's files. The blast radius is bounded by codex's `workspace-write` sandbox, which is in turn confined to `--cd`.
- **Why a separate result file rather than parsing stdout**: codex's `exec` stdout is verbose and meant for humans — reasoning traces, partial outputs, tool-call chatter. Asking codex to write a single result file at a known path is far more reliable than asking it to emit clean JSON to stdout interspersed with its normal output. As a bonus, it leaves stdout free for live progress streaming.
- **Why coerce unknown action verbs to `referenced`**: codex occasionally returns synonyms like `"modified"` or `"updated"`. Rejecting the whole run for a synonym would be hostile to callers; the wrapper rewrites and warns instead. The schema's `files` map is always one of the four canonical verbs.

## Compatibility notes

- Live-tested on Windows 11 + codex CLI against a ChatGPT Team plan. POSIX (macOS, Linux) is exercised by CI patterns inherited from `codex-image-gen` but the live billing path on POSIX is unverified — please open an issue if you hit anything platform-specific.
- `shell: true` is enabled on Windows only (required to spawn the `codex.cmd` shim post-CVE-2024-27980); on POSIX the script uses `shell: false` since `codex` resolves to a real binary.
- Requires Node 18+ for nullish coalescing (`??`) and `process.removeAllListeners`.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome. The tool is small (single ~300-line `.mjs` file) and intentionally zero-dep; please preserve both properties when proposing changes.

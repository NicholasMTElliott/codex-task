# codex-task

A small portable tool that lets Claude Code, opencode, Cline, Cursor, or any CLI coding agent **delegate a self-contained coding task to OpenAI's `codex` CLI and get back a structured JSON result** — billed against the user's ChatGPT subscription, not the API.

Companion to [`codex-image-gen`](https://github.com/NicholasMTElliott/codex-image-gen): same installer patterns, same target registry approach, different runtime payload.

Single mode: feed it a `--prompt` (or `--prompt-file`), it runs `codex exec` against your project, and emits JSON like:

```json
{
  "ok": true,
  "taskResult": "completed",
  "summary": "Renamed getCwd to getCurrentWorkingDirectory across 8 files; updated 3 tests.",
  "details": "Searched the repo for all occurrences of `getCwd` (15 hits). Renamed the function and call sites, updated import names, and adjusted the 3 tests that asserted on the old name. One TODO comment in `src/legacy.js` references the old name; left as-is since it's purely informational.",
  "files": {
    "src/utils/paths.js": "edited",
    "src/server/routes.js": "edited",
    "tests/paths.test.js": "edited"
  },
  "workdir":     "/abs/path/to/project",
  "sessionDir":  null,
  "model":       "gpt-5.5",
  "permissions": "workspace-write",
  "reasoningEffort": null,
  "warnings":    [],
  "durationMs":  84210
}
```

Action values are `created`, `deleted`, or `edited` by default. Pass `--track-references` to include `referenced` files too. The parent agent (Claude Code etc.) can audit changes without reading codex's full transcript.

**Default permissions are `read-only`** — codex can read your project but cannot modify any files. Pair with `--permissions workspace-write` when you want codex to actually edit. `read-only` is the right default for the bulk of delegated work: investigations, audits, codebase questions, multi-file analysis.

Ships with an Anthropic-style `SKILL.md` that the installer registers with each detected coding-agent harness (Claude Code, opencode, Cline, Cursor, …) so the agent knows when and how to invoke it.

## Why

When you're running on a Claude (or other paid) subscription and want to delegate a chunk of agent work — a multi-file refactor, scaffolding pass, exploratory investigation — to a fresh codex context, paying for that delegation in API tokens stings. `codex exec` against an authed ChatGPT plan bills the work to the user's existing subscription quota. This tool wraps `codex exec` with the right flags, environment, and prompt template so the delegating agent can call it without thinking about the gotchas — and gets back a stable JSON contract for what changed.

## What's in this directory

| File | Purpose |
|------|---------|
| `codex-task.mjs` | The tool. Plain Node ESM, no npm dependencies. |
| `install.mjs` | Cross-platform installer. Copies the tool to `~/.codex-task/` and registers the skill with each supported harness (Claude Code, opencode, Cline, Cursor). |
| `SKILL.md` | Skill template (Anthropic frontmatter — `name` + `description` + `allowed-tools`). The installer fills in the resolved install path and drops the same rendered file into every target's user-global skills dir. |
| `scripts/permission-matrix.mjs` | Manual Codex sandbox matrix. Not part of `npm test`; run it explicitly when validating permission behavior against a local project. |
| `memory-bank/` | LLM-optimized project context (projectBrief, productContext, systemPatterns, techContext). |
| `tests/` | Node test smoke coverage for the CLI help and installer target listing. |
| `package.json` | Open-source package metadata, scripts, engine, and optional `codex-task` bin entry. |
| `LICENSE` | MIT license. |
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
git clone https://github.com/NicholasMTElliott/codex-task.git
cd codex-task
node install.mjs
```

The runtime bin also forwards installer flags, so a copy of `codex-task.mjs` that has `install.mjs` next to it (repo checkout, npm package dir, or a `~/.codex-task/` written by a current installer) can run the installer. If `install.mjs` is missing (e.g. a `~/.codex-task/` from an older installer), the runtime prints a plain error to stderr and exits 1:

```bash
codex-task --install            # same as node install.mjs
codex-task --list-targets
codex-task --uninstall
```

Target-selection flags (`--target=`, `--all`, `--no-<id>`) forward too, e.g. `codex-task --install --target=claude,cursor`.

If you invoke the runtime for a task and the skill is **not** registered with any known harness, it prints a one-line warning to stderr and adds the same message to the result's `warnings` array — the run itself proceeds normally. Silence it with `--no-install-check` or `CODEX_TASK_SKIP_INSTALL_CHECK=1`.

### What the installer does

1. Verifies `node` and `codex` are on `PATH`.
2. Copies `codex-task.mjs`, `install.mjs`, `SKILL.md`, and `README.md` to `~/.codex-task/` (shared across all harnesses; the installer and template are included so `node ~/.codex-task/codex-task.mjs --install` / `--uninstall` keep working from the installed copy).
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

All flags work identically through the runtime bin: `codex-task --install --no-opencode`, `codex-task --list-targets`, etc.

To remove:

```bash
node install.mjs --uninstall     # or: codex-task --uninstall
```

## Manual invocation

POSIX (bash/zsh) — read-only investigation (default permissions):

```bash
node ~/.codex-task/codex-task.mjs \
  --prompt "Find every place in this repo that imports lodash.merge and list options for replacing each one."
```

Refactor (writes files — opt in with `--permissions`):

```bash
node ~/.codex-task/codex-task.mjs \
  --permissions workspace-write \
  --prompt "Rename getCwd to getCurrentWorkingDirectory across the repo, including tests."
```

With a long brief from a file, a specific model, explicit reasoning effort, and persistent output:

```bash
node ~/.codex-task/codex-task.mjs \
  --prompt-file ./refactor-brief.md \
  --permissions workspace-write \
  --model gpt-5.6-terra \
  --reasoning-effort high \
  --cwd path/to/project \
  --out /tmp/refactor-result.json
```

Windows PowerShell — `~` does not expand in arguments, use `$env:USERPROFILE`:

```powershell
node "$env:USERPROFILE\.codex-task\codex-task.mjs" `
  --prompt "Find every place in this repo that imports lodash.merge and list options for replacing each one."
```

Output is JSON on stdout. Codex's own progress chatter is captured silently by default; pass `--stream-thinking` to mirror it live to stderr. The per-session scratch dir lives under your OS temp directory (not inside the project), is removed automatically on success, and is preserved on failure — `sessionDir` in the JSON output points at it.

### Parameters

#### Task input (one required)

- `--prompt` — inline task description. Anything you'd tell codex to do.
- `--prompt-file` — path to a UTF-8 text file containing the task description. Mutually exclusive with `--prompt`. Trailing whitespace trimmed; internal newlines preserved.

#### Workspace

- `--cwd` (optional). Working directory codex operates inside (relative to caller cwd, or absolute). Default: caller cwd. Codex's sandbox is bounded by this directory (modulo `--permissions danger-full-access`).

#### Codex pass-throughs

- `--model` (optional, default `gpt-5.5`). Model codex should use. The set of supported values is plan-dependent — codex validates server-side and returns an error for anything your plan doesn't include. Common known names: `gpt-5.5`, `gpt-5.5-codex`, `gpt-5`, `gpt-5-codex`, and the GPT-5.6 tiers `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna`.
  - GPT-5.6 tier guidance (2026-07-09, CLI-validated with codex-cli 0.144.1: all three names accepted `--model` and completed a trivial prompt):
    - `gpt-5.6-sol` — flagship. Additionally accepts `--reasoning-effort max` and `ultra` (CLI-validated: both exit 0).
    - `gpt-5.6-terra` — balanced default among the 5.6 tier. Effort enum CLI-validated via a server 400: `none|minimal|low|medium|high|xhigh`.
    - `gpt-5.6-luna` — cheap/fast.
  - Effort sets are model- and plan-dependent (not just a fixed list), which is why the wrapper never validates `--reasoning-effort` client-side — codex is the source of truth.
- `--reasoning-effort` (optional, unset by default). Reasoning effort level, passed through to codex as `-c model_reasoning_effort="<level>"`. Plan- and model-dependent; codex validates server-side, so the wrapper performs no client-side enumeration. Commonly-seen levels (hints only, not a validated enum): `minimal|low|medium|high|xhigh`, plus `max`/`ultra` on some tiers (e.g. `gpt-5.6-sol`).
- `--permissions` (optional, default `read-only`). Sandbox policy for codex. Maps to codex's `--sandbox`:
  - `read-only` (default) — codex can read but not modify any file in the workspace.
  - `workspace-write` — codex can read AND write inside `--cwd`. Files outside the workdir remain read-only.
  - `danger-full-access` — codex can read AND write anywhere on the filesystem.

  The structured result is captured via codex's `--output-last-message` flag (a codex-process write, not a model write), so it works under any sandbox mode including `read-only`.
- `--profile` (optional). Codex config profile name. If set, codex loads option defaults from this profile in `~/.codex/config.toml`.

There is no wrapper `--search` flag. If the delegated task needs current web information, say so in the prompt, e.g. `--prompt "Search the web for the latest Codex release, then update docs/version.md."` Codex can perform web search from `codex exec` when explicitly instructed.

#### Wrapper options

- `--out` (optional). Also write the result JSON to this file path (still printed to stdout).
- `--debug` (optional flag). Keep the per-session scratch dir on success. Default cleans it up. Failed runs always preserve scratch regardless.
- `--stream-thinking` (optional flag). Mirror Codex live stdout/stderr to wrapper stderr. Default is silent capture only.
- `--track-references` (optional flag). Include `referenced` entries in `files`. Default omits referenced-only files.
- `--quiet` (optional flag). Compatibility flag; live thinking is already off by default, and `--quiet` suppresses streaming even when combined with `--stream-thinking`.
- `--no-install-check` (optional flag). Skip the startup check that warns when the codex-task skill is not registered with any known harness. The warning goes to stderr and into the result's `warnings` array; it never blocks the run. `CODEX_TASK_SKIP_INSTALL_CHECK=1` in the environment has the same effect.

### Output JSON shape

```json
{
  "ok": true,
  "taskResult": "completed",
  "summary":     "<one or two sentences>",
  "details":     "<markdown>",
  "files":       { "<path>": "created|deleted|edited", ... },
  "workdir":     "<absolute --cwd>",
  "sessionDir":  null,
  "model":       "<model used>",
  "permissions": "<permissions mode used>",
  "reasoningEffort": null,
  "warnings":    [],
  "durationMs":  12345
}
```

When `--reasoning-effort high` is passed, `reasoningEffort` echoes the resolved level instead of `null`:

```json
  "model":       "gpt-5.6-terra",
  "permissions": "workspace-write",
  "reasoningEffort": "high",
```

`ok` is `true` only when codex exits cleanly, its final message parses, and `taskResult` is `completed`. On `false`, inspect `taskResult`, `error`, `details`, and `warnings`; `sessionDir` is preserved for wrapper/runtime failures.

`taskResult` values:

- `completed` — requested outcome was fully achieved.
- `partial` — some requested outcomes were achieved, but not all.
- `blocked` — sandbox, auth, dependency, or another external constraint prevented the requested outcome.
- `failed` — Codex could not complete the requested outcome for another reason.

`files` action values are one of:

- `created` — file did not exist before; codex created it.
- `deleted` — file existed before; codex removed it.
- `edited` — file existed before; codex modified its contents.
- `referenced` — codex read the file as context but did not change it. Only present when `--track-references` is passed.

If codex returns an unknown action verb (`"modified"`, `"updated"`, etc.), the wrapper coerces it to `"referenced"` and emits a warning rather than failing the run. Referenced entries are omitted unless `--track-references` is set.

Inspect `warnings` for non-fatal anomalies: unknown action verbs, missing schema fields, cleanup failures.

`reasoningEffort` is the resolved `--reasoning-effort` level for this run, or `null` if the flag was omitted.

## Using it from a coding-agent harness

Once installed, **restart your agent** if it was already running — most harnesses load skills and settings only at startup. After that, just ask for a delegatable task in any project; the parent agent reads the skill description, decides it matches your request, and runs the tool for you.

Example dialogue (Claude Code):

> **You:** I want to rename `getCwd` to `getCurrentWorkingDirectory` everywhere it appears in this repo, including tests. Use codex-task — I'd rather not burn this conversation on it.
>
> **Claude:** *(invokes `node ~/.codex-task/codex-task.mjs --permissions workspace-write --prompt "Rename getCwd to getCurrentWorkingDirectory across this repo. Update every call site, every import, every test. Do not change anything else."`, waits ~60s, then reads the JSON and validates `ok`, `taskResult`, `summary`, and `files`)*

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

4. **`error: "codex did not write a final message file…"`** or **`"codex final message was empty"`** — codex finished cleanly but produced no final-message text. Probably the prompt confused it (e.g. you asked an open-ended question that codex answered conversationally without performing any task). Re-run with a clearer brief, or pass `--debug` and inspect `sessionDir` to see codex's actual output.

5. **Skill not auto-invoked from your agent** — verify install state with `node install.mjs --list-targets` (or `codex-task --list-targets`), then for each detected harness check the skill file exists and contains an absolute path (no `<<INSTALL_PATH>>` / `<<SCRIPT_PATH>>` placeholders left). **Restart the agent** if it was running when you installed. The runtime also warns on stderr (and in the JSON `warnings` array) when no harness has the skill registered — if you're seeing that warning, run `codex-task --install`.

6. **Worried about accidental API billing** — the wrapper strips `OPENAI_API_KEY` from the spawned env before invoking codex, so subscription routing is locked in regardless of what your shell has set.

7. **`codex` is not installed** — the wrapper checks `codex --version` before spending a run. If the binary is missing or not runnable, the JSON error tells you to install Codex and run `codex login`.

8. **Not logged in** — if `codex exec` returns an auth-shaped failure (`401`, missing bearer token, expired login), the JSON error includes the diagnostic tail and tells you to run `codex login`.

9. **Reasoning effort rejected** — if the diagnostic tail mentions `model_reasoning_effort` or reasoning effort, the chosen `--reasoning-effort` level is not supported for that model/plan. Drop the flag or pick a supported level such as `low`, `medium`, or `high`.

## Cost & timing

- Time scales with task scope. Trivial codebase questions: ~15-30s. Multi-file refactors: 1-5 minutes. Long investigations: 5+ minutes.
- Quota: text-only tasks burn ChatGPT subscription quota at the normal text rate (5-hour rolling cap + weekly cap). Plan accordingly for batch use.
- The wrapper is serial-by-design. Do not invoke it in parallel — codex's session-state handling corrupts under concurrent `CODEX_HOME` use.

## Manual permission matrix

The repo includes a manual harness for validating Codex sandbox behavior against a real local project. It is not run by `npm test` because it spends Codex quota and includes a `danger-full-access` case.

```powershell
node scripts/permission-matrix.mjs --yes --target ..\kva
```

Matrix:

| Permission | Read features | Write `FEATURES.<run>.md` in workspace | Write `FEATURES.<run>.md` to parent dir |
|------------|---------------|-----------------------------------------|------------------------------------------|
| `read-only` | should work | should fail | should fail |
| `workspace-write` | should work | should work | should fail |
| `danger-full-access` | should work | should work | should work |

Useful options:

- `--permission read-only` — run one permission row.
- `--task write-workspace-features` — run one task column.
- `--model <name>` — pass a model through to codex-task.
- `--stream-thinking` — ask codex-task to mirror live Codex chatter to stderr.
- `--keep-files` — keep successful probe files for inspection.

## Design notes

- **Why no npm deps**: keeps install trivial. Just `node install.mjs`. No `node_modules`, no version pinning, no transitive supply chain.
- **Why we delete `OPENAI_API_KEY`**: codex routes to API billing if it sees that variable, silently. We force subscription routing by stripping it from the spawned env.
- **Why we don't override `CODEX_HOME`**: codex stores its ChatGPT auth there. Override → fresh-install state → no auth → 401.
- **Why prompt is piped via stdin**: `codex exec` accepts the prompt as a positional arg, but on Windows with `shell:true` (required to spawn `codex.cmd` post-CVE-2024-27980) Node concatenates args without escaping, so a multi-word prompt gets split. Stdin sidesteps the issue.
- **Why hands-off operation**: `codex exec` defaults approval to `never`, and the wrapper does not expose interactive approval flags. Trade-off: codex can't pause to ask questions, so the parent agent must specify the task up-front.
- **Why `read-only` is the default**: most delegated agent work is investigation — "find every X", "summarize Y", "audit Z". Defaulting to a sandbox that can't modify the user's project makes "I tried codex-task and it broke my repo" impossible by construction. Refactors/edits opt in via `--permissions workspace-write`.
- **Why the scratch dir lives in OS temp, not in the workdir**: keeps the user's project clean of wrapper artifacts (no `.codex-task-tmp/` to add to `.gitignore`). Codex itself writes the agent's final message into the scratch dir via `--output-last-message`, which is a wrapper-process write and is unaffected by `--sandbox` — so `read-only` works end-to-end without needing any write-access concessions in the model sandbox.
- **Why `--cd` to the user's workdir, not a sandbox**: unlike `codex-image-gen` (which sandboxes codex in a fresh tmp dir for image generation), `codex-task` deliberately points codex at the user's project. The whole point is to perform work on the user's files. The blast radius is bounded by codex's `--sandbox` policy, which is in turn confined to `--cd`; the scratch dir is written by the codex CLI process only through `--output-last-message`.
- **Why `--ephemeral` by default**: this is a one-shot delegated task, not part of a persisted interactive session. We don't want every codex-task invocation cluttering codex's session history.
- **Why `--output-last-message` instead of parsing stdout**: codex's `exec` stdout is verbose — reasoning traces, tool-call chatter, partial outputs — and meant for humans. `--output-last-message` tells codex's CLI process to write *just* the agent's final message text to a file after the run, no interleaving. We tell the model in the prompt that its final message must be a single JSON object, and parse the file we get back.
- **Why no `--search` flag**: Codex can search the web when the prompt explicitly asks for it. The wrapper does not expose a separate search switch because there is nothing special to map; include web-research instructions in the task prompt.
- **Why thinking is opt-in**: parent agents should spend context on the final contract, not another agent's transcript. By default, Codex chatter is captured only for bounded diagnostic tails. `--stream-thinking` mirrors it to stderr when a human wants to watch.
- **Why references are opt-in**: for most delegated edits, changed files matter more than every file Codex inspected. By default, `files` omits `referenced` entries. `--track-references` restores the larger audit map.
- **Why coerce unknown action verbs to `referenced`**: codex occasionally returns synonyms like `"modified"` or `"updated"`. Rejecting the whole run for a synonym would be hostile to callers; the wrapper rewrites and warns instead. Referenced entries are omitted unless `--track-references` is set.

## Compatibility notes

- Live-tested on Windows 11 + codex CLI against a ChatGPT Team plan. POSIX (macOS, Linux) is exercised by CI patterns inherited from `codex-image-gen` but the live billing path on POSIX is unverified — please open an issue if you hit anything platform-specific.
- `shell: true` is enabled on Windows only (required to spawn the `codex.cmd` shim post-CVE-2024-27980); on POSIX the script uses `shell: false` since `codex` resolves to a real binary.
- Requires Node 18+ for nullish coalescing (`??`) and `process.removeAllListeners`.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome. The runtime is a single `.mjs` file and intentionally zero-dep; please preserve both properties when proposing changes.

---
name: codex-task
description: Delegate a self-contained coding task to a second agent (OpenAI's codex CLI) and get back structured JSON with taskResult, summary, details, and changed files. Routes billing through the user's ChatGPT subscription, NOT API tokens. Default permissions are `read-only` (codex cannot modify the user's files) — perfect for investigations, audits, and codebase questions. Pass `--permissions workspace-write` when you actually want codex to edit files. Use for medium-sized tasks you want offloaded to a fresh context — refactors, multi-file edits, codebase questions, scaffolding, exploratory investigation, and explicitly requested web research — where the parent agent wants a concise, machine-readable summary instead of a verbose transcript. Do NOT use for trivial one-line edits (just do them yourself), tasks that require live back-and-forth with the user, or tasks that need credentials/services codex doesn't have.
allowed-tools:
  - Bash(node <<SCRIPT_PATH>> *)
---

# codex-task

Shells out to the user's locally-installed `codex` CLI to perform an arbitrary agent task against the current project, and returns a structured JSON result. Billing flows through the user's ChatGPT subscription (no API tokens). Useful when you want to hand a self-contained chunk of work to a fresh agent context and get back a concise machine-readable result.

**Default permissions are `read-only`** — codex can read the workspace but cannot modify any files. This is the right default for investigations, audits, and codebase questions. Pass `--permissions workspace-write` when you want codex to actually edit files. Pass `--permissions danger-full-access` only when you explicitly need cross-tree writes outside the working directory.

## When to use

- Multi-file refactors with a clear brief ("rename `getCwd` → `getCurrentWorkingDirectory` across the repo and update tests") — pair with `--permissions workspace-write`.
- Scaffolding ("add a new express route at /health that returns process uptime and write a test") — pair with `--permissions workspace-write`.
- Exploratory investigation ("find every place we still depend on the deprecated `lodash.merge` and list options for replacing them") — default `read-only` is sufficient.
- Codebase questions you'd rather not load into your own context ("summarize the auth flow across these three services") — default `read-only` is sufficient.
- Anything where a structured `files` map is more useful to you than a chat transcript.

## When NOT to use

- Trivial single-line edits — just do them yourself.
- Tasks that need live user feedback or clarifying questions — codex runs non-interactively and won't pause to ask.
- Tasks needing credentials or private services codex isn't already wired up for.

Codex can access the web when the prompt explicitly asks it to search. No wrapper `--search` flag is needed; put the web-research instruction directly in `--prompt` / `--prompt-file`.
- Tasks where you've already loaded the relevant context and a hand-off would waste tokens re-reading the same files.
- Production-critical changes you wouldn't merge without a careful review — codex's `details` field is the only audit trail you get for free.

## How to invoke

```bash
node <<SCRIPT_PATH>> ( --prompt "<task>" | --prompt-file <path> ) \
  [--cwd DIR] [--out FILE] [--debug] [--quiet] \
  [--stream-thinking] [--track-references] \
  [--model MODEL] [--permissions read-only|workspace-write|danger-full-access] \
  [--profile NAME]
```

### Parameters

#### Task input (one required)

- `--prompt` (required if `--prompt-file` not given). Inline task description. Be specific — codex sees only this prompt and the project files; it does not see your conversation with the user.
- `--prompt-file` (required if `--prompt` not given; mutually exclusive with `--prompt`). Path to a UTF-8 text file containing the task description. Use for long briefs (multi-step refactors, acceptance criteria, code-style guides) that don't shell-escape cleanly. Trailing whitespace is trimmed; internal newlines are preserved.

#### Workspace

- `--cwd` (optional). Working directory codex operates inside (relative to your cwd, or absolute). Default: your current cwd. Codex's sandbox is confined to this directory (modulo `--permissions danger-full-access`). Point at a repo root for whole-project tasks; point at a subdir to confine codex to one area.

#### Codex pass-throughs

- `--model` (optional, default `gpt-5.5`). Model codex should use. The set of supported values is plan-dependent and not enumerable from the CLI — codex validates server-side and returns an error for anything your plan doesn't include. Common known names: `gpt-5.5`, `gpt-5.5-codex`, `gpt-5`, `gpt-5-codex`. Pick a stronger model for complex refactors / investigations; the default is fine for most tasks.
- `--permissions` (optional, default `read-only`). Sandbox policy for codex. Maps to codex's `--sandbox` flag (approval is always `never` because this wrapper is non-interactive):
  - `read-only` (default) — codex can read but not modify any file in the workspace. Use for investigations, audits, codebase questions.
  - `workspace-write` — codex can read AND write inside `--cwd`. Files outside the workdir remain read-only. Use for refactors and edits.
  - `danger-full-access` — codex can read AND write anywhere on the filesystem. Use only when you explicitly need cross-tree writes AND understand the blast radius.

  The structured result is captured via codex's `--output-last-message` flag — codex's CLI process writes the agent's final message to a wrapper-owned scratch file, which bypasses the model sandbox entirely. So `read-only` is fully functional: codex can read the workspace, write nothing in it, and still deliver the structured result.
- `--profile` (optional). Codex config profile name. If set, codex loads option defaults from this named profile in `~/.codex/config.toml`. Use only if the user has profiles configured.

#### Wrapper options

- `--out` (optional). Also write the result JSON to this file path. The JSON is always written to stdout regardless. Useful when you want to keep the result on disk for later review or to feed into a follow-up tool.
- `--debug` (optional flag). Preserve the per-session scratch dir on success. Default cleans it up. Failures always preserve scratch regardless. Set this only when you intend to inspect interim files.
- `--stream-thinking` (optional flag). Mirror Codex live stdout/stderr to wrapper stderr. Default is silent capture only. Avoid this when invoking from a parent agent unless the human explicitly wants the transcript.
- `--track-references` (optional flag). Include `referenced` entries in `files`. Default omits referenced-only files to keep the result small.
- `--quiet` (optional flag). Compatibility flag; live thinking is already off by default, and `--quiet` suppresses streaming even when combined with `--stream-thinking`.

### Output

JSON on stdout. Always inspect `ok`, `taskResult`, and `warnings` before acting on the result.

```json
{
  "ok": true,
  "taskResult": "completed",
  "summary": "Renamed getCwd to getCurrentWorkingDirectory across 8 files; updated 3 tests.",
  "details": "Searched the repo for all occurrences of `getCwd` (15 hits in 8 files). Renamed the function and call sites, updated import names, and adjusted the 3 tests that asserted on the old name. No public API broke — the function was internal-only. One TODO comment in `src/legacy.js` references the old name; left as-is since it's purely informational.",
  "files": {
    "src/utils/paths.js": "edited",
    "src/server/routes.js": "edited",
    "tests/paths.test.js": "edited"
  },
  "workdir":     "/abs/path/to/project",
  "sessionDir":  null,
  "model":       "gpt-5.5",
  "permissions": "workspace-write",
  "warnings":    [],
  "durationMs":  84210
}
```

#### Field semantics

- `ok` — true iff codex exited cleanly, its final message parsed, and `taskResult` is `completed`. On false, inspect `taskResult`, `error`, `details`, and `warnings`.
- `taskResult` — one of:
  - `completed` — requested outcome was fully achieved.
  - `partial` — some requested outcomes were achieved, but not all.
  - `blocked` — sandbox, auth, dependency, or another external constraint prevented the requested outcome.
  - `failed` — codex could not complete the requested outcome for another reason.
- `summary` — one or two sentences describing what was done at a high level. Show this to the user.
- `details` — longer markdown explanation including reasoning, caveats, and follow-ups. Read this before accepting the changes.
- `files` — map of `<path>` → `<action>` where action is one of:
  - `created` — codex created this file (didn't exist before).
  - `deleted` — codex deleted this file (did exist before).
  - `edited` — codex modified an existing file.
  - `referenced` — codex read this file as context but didn't modify or delete it. Only present when `--track-references` is passed.
  Unknown actions from codex are coerced to `referenced` with a warning. Referenced entries are omitted unless `--track-references` is set.
- `workdir` — absolute path of the directory codex worked inside. Same as `--cwd` resolved against caller cwd.
- `sessionDir` — `null` after the default cleanup; the absolute scratch dir path otherwise (on failure or `--debug`). Lives under OS temp, not under the workdir.
- `model` / `permissions` — the resolved values for this run. Useful so callers don't have to re-derive what was passed.
- `warnings` — non-fatal anomalies (unknown action verbs, missing schema fields, cleanup failures). Worth re-reading before acting.
- `durationMs` — wall-clock duration of the codex run plus this wrapper's overhead.

## After invoking

1. Check `ok` and `taskResult` first. Treat `blocked`, `failed`, and `partial` as needing review before acting.
2. Read `summary` for the headline; read `details` for the context.
3. Walk `files` to see what changed. For each `edited`/`created` entry, consider whether to read the file yourself before acting on it — codex's `details` is informal, not a contract.
4. If `ok: false`, inspect `taskResult`, `error`, and `sessionDir` where present. Re-run only if it looks like a transient codex hiccup.
5. The wrapper does not pollute the user's project with a scratch dir — `sessionDir` lives under OS temp. Nothing to add to `.gitignore`.

## Cost & timing awareness

- Each invocation spawns a fresh `codex exec --ephemeral`. There is no session continuity — multiple invocations re-read the project from scratch.
- Time scales with task scope. Trivial codebase questions: ~15-30s. Multi-file refactors: 1-5 minutes. Long investigations: 5+ minutes.
- Quota: text-only tasks burn ChatGPT subscription quota at the normal text rate (5-hour rolling cap + weekly cap). Plan accordingly for batch use.
- The wrapper is serial-by-design. Do not invoke it in parallel — codex's session-state handling corrupts under concurrent `CODEX_HOME` use.

## Prompt tips

- Be specific about scope. "Refactor X" is vague; "Rename function X to Y across `src/` and `tests/`, leaving `vendor/` alone, and update the JSDoc" is actionable.
- State acceptance criteria. "Test must pass with `npm test`." "Don't introduce new dependencies." "Preserve public API."
- For investigations, state the deliverable. Use `--track-references` only when the caller needs an audit list of files read.
- Codex sees only the prompt and the files in `--cwd`. It does not see your conversation. Inline anything from your context that matters.
- Match `--permissions` to the task. `read-only` for any task that doesn't intentionally modify files; `workspace-write` for refactors and scaffolding; `danger-full-access` only when you've truly thought about it.

## Failure modes

- `error: "codex CLI was not found on PATH..."` — install OpenAI Codex, make sure `codex` is on `PATH`, run `codex login`, then retry.
- `error: "codex exited with code N"` — usually auth (run `codex login`), out-of-quota (check ChatGPT plan limits), or codex sandbox refusal. Re-run after fixing.
- `error: "codex did not write a final message file…"` / `"codex final message was empty"` — codex finished but produced no final-message text. Re-run with a clearer brief.
- `error: "codex final message is not valid JSON and contains no extractable JSON object"` — codex's final message was prose, not JSON. The wrapper strips ` ```json ` fences and falls back to extracting the first balanced `{...}` block, so this only fires when codex truly went off-script. Re-run with a clearer brief.
- `warnings` non-empty + `ok: true` — completed with normalization or cleanup notes. Read the warnings, possibly re-run if the data you need is missing.
- `error: model "X" is not supported when using Codex with a ChatGPT account` — pass a model your plan supports (e.g. omit `--model` to use the default `gpt-5.5`).

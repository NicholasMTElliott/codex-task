---
name: codex-task
description: Delegate a self-contained coding task to a second agent (OpenAI's codex CLI) and get back a structured JSON result with a summary, details, and a per-file action map (created/deleted/edited/referenced). Routes billing through the user's ChatGPT subscription, NOT API tokens. Use for medium-sized tasks you want offloaded to a fresh context — refactors, multi-file edits, codebase questions, scaffolding, exploratory investigation — where the parent agent wants a concise, machine-readable summary instead of a verbose transcript. Do NOT use for trivial one-line edits (just do them yourself), tasks that require live back-and-forth with the user, or tasks that need external network/credentials codex doesn't have.
allowed-tools:
  - Bash(node <<SCRIPT_PATH>> *)
---

# codex-task

Shells out to the user's locally-installed `codex` CLI to perform an arbitrary agent task against the current project, and returns a structured JSON result. Billing flows through the user's ChatGPT subscription (no API tokens). Useful when you want to hand a self-contained chunk of work to a fresh agent context and get back a concise machine-readable summary of what changed.

## When to use

- Multi-file refactors with a clear brief ("rename `getCwd` → `getCurrentWorkingDirectory` across the repo and update tests").
- Scaffolding ("add a new express route at /health that returns process uptime and write a test").
- Exploratory investigation ("find every place we still depend on the deprecated `lodash.merge` and list options for replacing them").
- Codebase questions you'd rather not load into your own context ("summarize the auth flow across these three services").
- Anything where a structured `files` map is more useful to you than a chat transcript.

## When NOT to use

- Trivial single-line edits — just do them yourself.
- Tasks that need live user feedback or clarifying questions — codex runs in `--full-auto` and won't pause to ask.
- Tasks needing external network access, credentials, or services codex isn't already wired up for.
- Tasks where you've already loaded the relevant context and a hand-off would waste tokens re-reading the same files.
- Production-critical changes you wouldn't merge without a careful review — codex's `details` field is the only audit trail you get for free.

## How to invoke

```bash
node <<SCRIPT_PATH>> ( --prompt "<task>" | --prompt-file <path> ) \
  [--cwd DIR] [--out FILE] [--debug] [--quiet]
```

### Parameters

- `--prompt` (required if `--prompt-file` not given). Inline task description. Be specific — codex sees only this prompt and the project files; it does not see your conversation with the user.
- `--prompt-file` (required if `--prompt` not given; mutually exclusive with `--prompt`). Path to a UTF-8 text file containing the task description. Use for long briefs (multi-step refactors, acceptance criteria, code-style guides) that don't shell-escape cleanly. Trailing whitespace is trimmed; internal newlines are preserved.
- `--cwd` (optional). Working directory codex operates inside (relative to your cwd, or absolute). Default: your current cwd. Codex's workspace-write sandbox is confined here, so this directory bounds the blast radius. Point at a repo root for whole-project tasks; point at a subdir to confine codex to one area.
- `--out` (optional). Also write the result JSON to this file path. The JSON is always written to stdout regardless. Useful when you want to keep the result on disk for later review or to feed into a follow-up tool.
- `--debug` (optional flag). Preserve the per-session tmp dir on success. Default cleans it up. Failures always preserve tmp regardless. Set this only when you intend to inspect interim files.
- `--quiet` (optional flag). Discard codex's live log output instead of streaming it to stderr. By default codex chatter prints to stderr so the user can follow progress; structured stdout (JSON) is unaffected either way.

### Output

JSON on stdout. Always inspect `ok` and `warnings` before acting on the result.

```json
{
  "ok": true,
  "summary": "Renamed getCwd to getCurrentWorkingDirectory across 8 files; updated 3 tests.",
  "details": "Searched the repo for all occurrences of `getCwd` (15 hits in 8 files). Renamed the function and call sites, updated import names, and adjusted the 3 tests that asserted on the old name. No public API broke — the function was internal-only. One TODO comment in `src/legacy.js` references the old name; left as-is since it's purely informational.",
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

#### Field semantics

- `ok` — true iff codex exited cleanly AND produced a parseable result file. On false, inspect `error` and `warnings`.
- `summary` — one or two sentences describing what was done at a high level. Show this to the user.
- `details` — longer markdown explanation including reasoning, caveats, and follow-ups. Read this before accepting the changes.
- `files` — map of `<path>` → `<action>` where action is one of:
  - `created` — codex created this file (didn't exist before).
  - `deleted` — codex deleted this file (did exist before).
  - `edited` — codex modified an existing file.
  - `referenced` — codex read this file as context but didn't modify or delete it.
  Unknown actions from codex are coerced to `referenced` with a warning, so the map shape is always stable.
- `workdir` — absolute path of the directory codex worked inside. Same as `--cwd` resolved against caller cwd.
- `sessionDir` — `null` after the default cleanup; the absolute tmp dir path otherwise (on failure or `--debug`).
- `warnings` — non-fatal anomalies (unknown action verbs, missing schema fields, cleanup failures). Worth re-reading before acting.
- `durationMs` — wall-clock duration of the codex run plus this wrapper's overhead.

## After invoking

1. Read `summary` for the headline; read `details` for the context.
2. Walk `files` to see what changed. For each `edited`/`created` entry, consider whether to read the file yourself before acting on it — codex's `details` is informal, not a contract.
3. If `ok: false`, inspect `error` and `sessionDir` (preserved on failure). Re-run if it looks like a transient codex hiccup.
4. Add `.codex-task-tmp/` to the project's `.gitignore` (the tmp dir is auto-cleaned on success but lingers on failure).

## Cost & timing awareness

- Each invocation spawns a fresh `codex exec`. There is no session continuity — multiple invocations re-read the project from scratch.
- Time scales with task scope. Trivial codebase questions: ~15-30s. Multi-file refactors: 1-5 minutes. Long investigations: 5+ minutes.
- Quota: text-only tasks burn ChatGPT subscription quota at the normal text rate (5-hour rolling cap + weekly cap). Plan accordingly for batch use.
- The wrapper is serial-by-design. Do not invoke it in parallel — codex's session-state handling corrupts under concurrent `CODEX_HOME` use.

## Prompt tips

- Be specific about scope. "Refactor X" is vague; "Rename function X to Y across `src/` and `tests/`, leaving `vendor/` alone, and update the JSDoc" is actionable.
- State acceptance criteria. "Test must pass with `npm test`." "Don't introduce new dependencies." "Preserve public API."
- For investigations, state the deliverable. "Return a `files` map of every place that imports `lodash.merge`, with `details` listing options for each."
- Codex sees only the prompt and the files in `--cwd`. It does not see your conversation. Inline anything from your context that matters.

## Failure modes

- `error: "codex exited with code N"` — usually auth (run `codex login`), out-of-quota (check ChatGPT plan limits), or codex sandbox refusal. Re-run after fixing.
- `error: "result file not written by codex…"` — codex finished cleanly but didn't write the structured result. Probably the prompt confused it. Re-run with a clearer brief, or pass `--debug` and inspect `sessionDir` to see codex's actual output.
- `error: "result file is not valid JSON…"` — codex wrote something but it wasn't well-formed JSON. The tool already strips ` ```json ` fences; if it still fails, codex hallucinated. Re-run.
- `warnings` non-empty + `ok: true` — partial success. Common causes: codex used an unknown action verb (demoted to `referenced`), or codex omitted `summary`/`details` from the result. Read the warnings, possibly re-run if the data you need is missing.

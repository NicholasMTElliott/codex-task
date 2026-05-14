# productContext

## Problem
A "parent" coding agent (Claude Code, opencode, etc.) running on a Claude subscription often wants to delegate a self-contained chunk of work — documentation writing, summary generation, prose cleanup, exploratory questions, and occasionally explicit implementation work — to a fresh agent context without spending its own conversation budget on it. Calling OpenAI's API directly for this burns API tokens. Many users have a ChatGPT Plus/Pro subscription whose quota would otherwise go unused.

## Solution
Wrap `codex exec` so a parent agent can hand a free-form prompt to codex, let codex execute against the current project, and receive back a structured JSON result with:
- A short **summary** (one or two sentences, for surfacing to the user).
- A **taskResult** enum (`completed|partial|blocked|failed`) that says whether the requested outcome actually happened.
- A longer **details** field (markdown explaining reasoning, caveats, follow-ups).
- A per-file **files** map (`<path>` → `created|deleted|edited` by default; `referenced` included only with `--track-references`) so the parent agent can audit changes without reading codex's full transcript.

Billing flows through the ChatGPT subscription as long as `OPENAI_API_KEY` is unset in the spawned env.

## Functional intent

### Inputs
- `--prompt` / `--prompt-file` — the task description. Inline or from a UTF-8 text file. Mutually exclusive. File variant useful for long multi-line briefs that don't shell-escape cleanly; trailing whitespace trimmed, internal newlines preserved.
- `--cwd` — working directory codex operates inside (relative or absolute; default: caller cwd). Codex's sandbox is bounded by this directory (modulo `--permissions danger-full-access`).
- `--model` — codex model name. Default: `gpt-5.5`. The supported set is plan-dependent and not enumerable from the CLI; codex returns 400 with "not supported when using Codex with a ChatGPT account" for anything the user's plan doesn't include. Common known values surfaced in `--help`: `gpt-5.5`, `gpt-5.5-codex`, `gpt-5`, `gpt-5-codex`.
- `--permissions` — sandbox policy. Default `read-only`. Values: `read-only` (codex can read but not modify the workspace), `workspace-write` (codex can read AND write inside `--cwd`), `danger-full-access` (codex can write anywhere). Maps directly to codex's supported `--sandbox` values. Approval is always `never` in the wrapper since it's non-interactive.
- `--profile` — optional codex config profile name (pass-through to codex's `--profile`).
- `--out` — also write the result JSON to this file path (still printed to stdout). Useful for piping or persistence.
- `--debug` — preserve the per-session scratch dir on success (default cleans it up; failures always preserve).
- `--stream-thinking` — opt in to mirroring Codex live stdout/stderr to wrapper stderr. Default is silent capture only.
- `--track-references` — include `referenced` entries in the `files` map. Default omits referenced-only files to keep parent-agent context small.
- `--quiet` — compatibility flag; suppresses live streaming even with `--stream-thinking`.

### Behavior
- The tool builds a wrapper prompt: a fixed preamble explaining that the agent's FINAL message must be a single JSON object of a specific shape (with a `read-only`-aware addendum when applicable), followed by the user's task.
- Preflights `codex --version`; missing/not-runnable Codex returns structured JSON before attempting a run. Then spawns `codex exec` with `--skip-git-repo-check`, `--ephemeral`, `--sandbox <mapped from --permissions>`, `--cd <workdir>`, `--model <model>`, `--output-last-message <sessionDir>/last-message.txt`, plus `--profile <name>` conditionally. `OPENAI_API_KEY` is deleted from the spawned env. Prompt is piped via stdin.
- Codex's stdout/stderr is captured to bounded tails and is NOT streamed by default. `--stream-thinking` mirrors it live to wrapper stderr. Our stdout is reserved for the final JSON result. Non-zero exits surface the diagnostic tail with hints for auth, quota, model support, and sandbox failures.
- After codex exits cleanly, the tool reads `<sessionDir>/last-message.txt` (codex's CLI process writes this — bypasses the model sandbox), tries strict `JSON.parse`, falls back to fence stripping and balanced-brace extraction if the model added prose around the JSON, validates the shape, normalizes sloppy fields, filters referenced files unless `--track-references`, and emits the final JSON. `ok` is true only when `taskResult` is `completed`.
- On success without `--debug`, removes the scratch dir. On failure or `--debug`, preserves it; failures surface `sessionDir` in the JSON so the caller can inspect codex's interim output.

### Output (JSON on stdout)
```json
{
  "ok": true,
  "taskResult": "completed",
  "summary":     "<one or two sentences>",
  "details":     "<markdown>",
  "files":       { "<path>": "created|deleted|edited", ... },
  "workdir":     "<absolute path codex was --cd'd to>",
  "sessionDir":  null,
  "model":       "<model used>",
  "permissions": "<permissions mode used>",
  "warnings":    [],
  "durationMs":  12345
}
```

On failure: `ok: false`, an `error` field with a stderr tail or parse-failure message, and (usually) `sessionDir` non-null so the caller can dig in.

## UX expectations
- The wrapper takes whatever the underlying codex run takes, typically 15s for trivial codebase questions, 1-5 minutes for multi-file refactors, longer for exploratory investigation. There is no progress signal by default; pass `--stream-thinking` for live Codex chatter on stderr.
- The scratch dir lives outside the user's project (under OS tmp), so the workdir is never polluted with a wrapper-owned folder. Nothing to add to `.gitignore`.
- The structured JSON is the canonical handoff. `ok` + `taskResult` determine whether the delegated outcome succeeded. The `summary` field is the one to surface to the human user; `details` is for the parent agent to read; `files` is for changed-file audit by default.
- The skill should be leaned on proactively for technical/creative writing, documentation drafts, feature summaries, changelog/release-note prose, README improvements, and narrative cleanup. Coding and code execution are valid but secondary: delegate them when specifically requested or when the task brief clearly asks Codex to implement.
- Codex runs non-interactively; `codex exec` defaults approval to `never`, so there are no clarifying questions or per-command prompts. The parent agent must specify the task fully up-front.
- The `read-only` default permission means the wrapper is safe to invoke for investigations without worry about codex modifying the workspace. Refactors and edits require opting in via `--permissions workspace-write`. Cross-tree writes require `--permissions danger-full-access`. The wrapper documents this trade-off heavily in the prompt under `read-only` so codex describes intended edits in `details` rather than failing when its writes are blocked.
- Failures (`ok: false`) preserve the scratch dir regardless of `--debug`; users can inspect codex's interim output without re-running.

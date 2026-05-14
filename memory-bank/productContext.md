# productContext

## Problem
A "parent" coding agent (Claude Code, opencode, etc.) running on a Claude subscription often wants to delegate a self-contained chunk of work — a refactor, a scaffolding pass, an exploratory question — to a fresh agent context without spending its own conversation budget on it. Calling OpenAI's API directly for this burns API tokens. Many users have a ChatGPT Plus/Pro subscription whose quota would otherwise go unused.

## Solution
Wrap `codex exec --full-auto` so a parent agent can hand a free-form prompt to codex, let codex execute against the current project, and receive back a structured JSON result with:
- A short **summary** (one or two sentences, for surfacing to the user).
- A longer **details** field (markdown explaining reasoning, caveats, follow-ups).
- A per-file **files** map (`<path>` → `created|deleted|edited|referenced`) so the parent agent can audit what changed without reading codex's full transcript.

Billing flows through the ChatGPT subscription as long as `OPENAI_API_KEY` is unset in the spawned env.

## Functional intent

### Inputs
- `--prompt` / `--prompt-file` — the task description. Inline or from a UTF-8 text file. Mutually exclusive. File variant useful for long multi-line briefs that don't shell-escape cleanly; trailing whitespace trimmed, internal newlines preserved.
- `--cwd` — working directory codex operates inside (relative or absolute; default: caller cwd). Codex's `workspace-write` permission is confined to this directory, so it bounds the blast radius of the task.
- `--out` — also write the result JSON to this file path (still printed to stdout). Useful for piping or persistence.
- `--debug` — preserve the per-session tmp dir on success (default cleans it up; failures always preserve).
- `--quiet` — discard codex's live log output instead of streaming it to stderr.

### Behavior
- The tool builds a wrapper prompt: it prepends a fixed preamble explaining the JSON shape codex must write, includes the user's task, and ends with the result-file path.
- Spawns `codex exec --full-auto --skip-git-repo-check --cd <workdir>` with `OPENAI_API_KEY` deleted, prompt piped via stdin.
- Codex's stdout streams **live** to our stderr (so the user can follow progress) unless `--quiet`. Our stdout is reserved for the final JSON result.
- After codex exits cleanly, the tool reads `<workdir>/.codex-task-tmp/<sessionId>/result.json`, validates the shape, normalizes any sloppy fields (coerces unknown action verbs to `referenced` with a warning), and emits the final JSON.
- Strips a leading ` ```json ` fence and trailing ``` from the result file if codex wrapped it in markdown despite instructions.
- On success without `--debug`, removes the session tmp dir. On failure or `--debug`, preserves it; failures surface `sessionDir` in the JSON so the caller can inspect codex's interim output.

### Output (JSON on stdout)
```json
{
  "ok": true,
  "summary":    "<one or two sentences>",
  "details":    "<markdown>",
  "files":      { "<path>": "created|deleted|edited|referenced", ... },
  "workdir":    "<absolute path codex was --cd'd to>",
  "sessionDir": null,
  "warnings":   [],
  "durationMs": 12345
}
```

On failure: `ok: false`, an `error` field with a stderr tail or parse-failure message, and (usually) `sessionDir` non-null so the caller can dig in.

## UX expectations
- The wrapper takes whatever the underlying codex run takes, typically 15s for trivial codebase questions, 1-5 minutes for multi-file refactors, longer for exploratory investigation. There is no progress signal beyond codex's live chatter on stderr.
- The `.codex-task-tmp/` dir appears in the working directory only briefly on success; it persists on failure. Users should add it to `.gitignore`.
- The structured JSON is the canonical handoff. The `summary` field is the one to surface to the human user; `details` is for the parent agent to read; `files` is for the parent agent to audit.
- Codex runs in `--full-auto` — no interactive prompts. The wrapper is unsuitable for tasks that need clarifying questions; the parent agent must specify them up-front.
- Failures (`ok: false`) preserve tmp regardless of `--debug`; users can inspect codex's interim output without re-running.

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
- `--cwd` — working directory codex operates inside (relative or absolute; default: caller cwd). Codex's sandbox is bounded by this directory (modulo `--permissions danger-full-access`).
- `--model` — codex model name. Default: `gpt-5.5`. The supported set is plan-dependent and not enumerable from the CLI; codex returns 400 with "not supported when using Codex with a ChatGPT account" for anything the user's plan doesn't include. Common known values surfaced in `--help`: `gpt-5.5`, `gpt-5.5-codex`, `gpt-5`, `gpt-5-codex`.
- `--permissions` — sandbox policy. Default `read-only`. Values: `read-only` (codex can read but not modify the workspace), `workspace-write` (codex can read AND write inside `--cwd`), `full-auto` (alias for `workspace-write`), `danger-full-access` (codex can write anywhere). Maps to codex's `--sandbox` flag. Approval is always `never` in the wrapper since it's non-interactive.
- `--profile` — optional codex config profile name (pass-through to codex's `--profile`).
- `--out` — also write the result JSON to this file path (still printed to stdout). Useful for piping or persistence.
- `--debug` — preserve the per-session scratch dir on success (default cleans it up; failures always preserve).
- `--quiet` — discard codex's live log output instead of streaming it to stderr.

### Behavior
- The tool builds a wrapper prompt: a fixed preamble explaining that the agent's FINAL message must be a single JSON object of a specific shape (with a `read-only`-aware addendum when applicable), followed by the user's task.
- Spawns `codex exec` with `--skip-git-repo-check`, `--ephemeral`, `--sandbox <mapped from --permissions>`, `--cd <workdir>`, `--model <model>`, `--output-last-message <sessionDir>/last-message.txt`, plus `--profile <name>` conditionally. `OPENAI_API_KEY` is deleted from the spawned env. Prompt is piped via stdin.
- Codex's stdout/stderr streams **live** to our stderr (so the user can follow progress) unless `--quiet`. Our stdout is reserved for the final JSON result.
- After codex exits cleanly, the tool reads `<sessionDir>/last-message.txt` (codex's CLI process writes this — bypasses the model sandbox), tries strict `JSON.parse`, falls back to fence stripping and balanced-brace extraction if the model added prose around the JSON, validates the shape, normalizes any sloppy fields (coerces unknown action verbs to `referenced` with a warning), and emits the final JSON.
- On success without `--debug`, removes the scratch dir. On failure or `--debug`, preserves it; failures surface `sessionDir` in the JSON so the caller can inspect codex's interim output.

### Output (JSON on stdout)
```json
{
  "ok": true,
  "summary":     "<one or two sentences>",
  "details":     "<markdown>",
  "files":       { "<path>": "created|deleted|edited|referenced", ... },
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
- The wrapper takes whatever the underlying codex run takes, typically 15s for trivial codebase questions, 1-5 minutes for multi-file refactors, longer for exploratory investigation. There is no progress signal beyond codex's live chatter on stderr.
- The scratch dir lives outside the user's project (under OS tmp), so the workdir is never polluted with a wrapper-owned folder. Nothing to add to `.gitignore`.
- The structured JSON is the canonical handoff. The `summary` field is the one to surface to the human user; `details` is for the parent agent to read; `files` is for the parent agent to audit.
- Codex runs non-interactively with `--ask-for-approval never` — no clarifying questions, no per-command prompts. The parent agent must specify the task fully up-front.
- The `read-only` default permission means the wrapper is safe to invoke for investigations without worry about codex modifying the workspace. Refactors and edits require opting in via `--permissions workspace-write` (or the `full-auto` alias). The wrapper documents this trade-off heavily in the prompt under `read-only` so codex describes intended edits in `details` rather than failing when its writes are blocked.
- Failures (`ok: false`) preserve the scratch dir regardless of `--debug`; users can inspect codex's interim output without re-running.

export const SKILL_MD = `---
name: pitfall-hub
description: Cross-project pitfall knowledge base (MCP tools search_pitfalls, match_error, get_pitfall, record_pitfall, update_pitfall, pitfall_feedback). Use when an error or unexpected behaviour shows up, before configuring tooling/build/deploy/env, when adopting a library, and after solving something non-obvious so it is not repeated in other projects.
---

# pitfall-hub

A local knowledge base of pitfalls I have already hit and solved in *other* projects.
Per-project memory does not transfer; this does. Hooks surface entries automatically
(at session start by project stack, and when a Bash command fails), but they only fire on
confident matches — search explicitly when in doubt.

## Retrieve

- **Hit an error I don't immediately understand** → \`match_error\` with the raw output, or
  \`search_pitfalls\` with the distinctive part of the message. Do this *before* the second
  debugging attempt, not after the fifth.
- **About to do something with a history of traps** (package manager / build config, native
  modules, Docker, WSL paths, auth, CI, version upgrades, a library I rarely use) →
  \`search_pitfalls\` with the tool/library name.
- A surfaced entry is a hint, not a fact: check its environment/versions against this project.
  Then call \`pitfall_feedback\`: \`helpful\` if it applied, \`outdated\` (with a note) if it no
  longer holds.

## Record

After a fix, ask: *would I plausibly hit this again in a different project?* Record if yes and
any of these hold:
- it took more than one attempt, or the error message pointed the wrong way;
- it is tool / library / platform / version behaviour, not this project's business logic;
- the fix is not the first thing a quick search or the docs would give.

Do not record typos, project-specific facts (those belong in project memory / CLAUDE.md), or
generic advice.

How to write a good entry:
- **title**: the trap itself, searchable — "pnpm v10 silently skips sharp's build script",
  not "fixed install".
- **symptom**: paste the key error lines verbatim (future matching is lexical).
- **error_signature**: the single most distinctive line (an error code, a specific message).
  Skip generic lines like "Command failed with exit code 1".
- **cause** and **solution**: the real root cause, and the exact command/config that fixed it.
- **prevention**: the check that would have avoided it.
- **tags**: package names exactly as in package.json / pyproject (\`next\`, \`vite\`, \`prisma\`)
  plus ecosystem and platform (\`node\`, \`python\`, \`pnpm\`, \`docker\`, \`wsl\`, \`macos\`).
  Tags decide which projects get the entry at session start. Reuse existing tags
  (\`list_pitfall_tags\`).
- **environment**: versions and OS it was seen on.
- **project**: the current project's directory name.
- Write in the user's language; keep error text and identifiers verbatim.

\`record_pitfall\` refuses exact duplicates and returns the existing entry — then use
\`update_pitfall\` with \`append_note\` for the new variant instead of creating a near-copy.
`

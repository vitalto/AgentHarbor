# Repository guidance

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.

## Codex command output

When `rtk` is available, use `rtk git status` for routine status checks and run the project's existing test and typecheck scripts through `rtk test`. For review, read the full `git diff`. If a check fails, read the original output using the `rtk recall` command printed by RTK when shown.

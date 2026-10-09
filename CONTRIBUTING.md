# Contributing to AgentHarbor

AgentHarbor is a small fork maintained by one person. Bug reports and focused pull requests are
welcome at https://github.com/vitalto/AgentHarbor.

- **Bugs**: open an issue with steps to reproduce, your OS / WSL setup, tmux and Claude Code
  versions, and the relevant server log lines.
- **Features**: open an issue first so we can agree on the scope before you write code.
- **Upstream bugs**: if a bug also exists in CloudCLI UI, the project AgentHarbor is derived from,
  consider reporting it upstream too.

## Development setup

Requirements: Linux or WSL 2, tmux >= 3.3, Node.js 22, Claude Code CLI.

```bash
git clone https://github.com/<your-username>/AgentHarbor.git
cd AgentHarbor
npm ci
npm run dev        # Vite on :5173 plus the API server
```

Useful scripts:

| Command | What it does |
|---|---|
| `npm run build` | Production build of the client (`dist/`) and server (`dist-server/`) |
| `npm run server` | Run the built server |
| `npm run typecheck` | TypeScript checks for client and server |
| `npm test` | Server tests (`node:test`) |
| `npm run test:client` | Client tests (Vitest) |
| `npm run lint` | oxlint over `src/` and `server/` |

Repository layout: `src/` is the React frontend, `server/` the Express + WebSocket backend
(`server/modules/tmux` holds the tmux / Claude TUI runtime), `shared/` code used by both, `public/`
static assets. Coding standards for each side live in `.agents/skills/`.

## Pull requests

- One topic per PR; describe what changed and why, and how you tested it.
- Make sure typecheck, tests, lint and the build pass.
- Commit messages follow [Conventional Commits](https://conventionalcommits.org/)
  (`feat: ...`, `fix(chat): ...`), enforced by commitlint.
- Include a screenshot for visible UI changes (desktop and phone width when layout is affected).

## License

By contributing you agree that your contributions are licensed under the
[AGPL-3.0-or-later](LICENSE), including the additional terms in Section 7 of the LICENSE file.

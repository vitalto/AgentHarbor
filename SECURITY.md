# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through
[GitHub security advisories](https://github.com/vitalto/AgentHarbor/security/advisories/new).
Include the version or commit, your setup (Linux or WSL, how the server is exposed) and steps to
reproduce. You should get an answer within a week.

Only the latest commit on `main` is supported.

## Threat model

AgentHarbor gives whoever logs in the same power as the account that runs it: they can type into
your Claude Code agents, open a shell in the terminal tab, and read and write files in your
projects. Treat the login like an ssh key.

- There is no TLS built in. Bind `HOST` to `127.0.0.1` or a LAN/VPN address, or put the server
  behind a reverse proxy with TLS. Never expose the port directly to the internet.
- There is one account. Registration closes once it exists.
- The agents themselves run with your user's rights. AgentHarbor does not sandbox them; Claude
  Code's own permission modes are what limits them.
- The optional elevation approvals (`/api/elevation`) only show and record your decision. They are
  as strong as the external broker that executes the commands: a decision file in your profile can
  be written by any process running as your user, including the agents, so approvals are a
  convenience against accidents, not a security boundary.

# Security Policy

SoftwareAgents launches AI coding CLIs with real file and process access, so security reports are
very welcome. Read the [threat model](docs/security/threat-model.md) for what is in scope and which
residual risks are already accepted.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/fedeggarrido/SoftwareAgents/security/advisories/new).
**Do not open a public issue for security vulnerabilities.**

This is a personal project: reports are answered on a best-effort basis, and only the latest `main`
is supported.

## Scope

- Agents or external content escaping their containment (worktree, hooks, permission profile)
- Getting an operator decision approved without the operator's token
- Credentials or tokens leaking to agent processes, logs or the webview
- Command injection, path traversal or arbitrary file read/write
- XSS or unauthenticated control through the office's HTTP/WebSocket server

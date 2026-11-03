# Contributing to SoftwareAgents

Thanks for your interest. SoftwareAgents is a personal project, so contributions are welcome but
reviewed on a best-effort basis. For anything larger than a small fix, open an issue first.

## Setup

Requirements: Node.js ≥ 22.5 and Git. Claude Code and/or Codex CLI are only needed to run real
agents; tests use mocked CLIs.

```bash
git clone https://github.com/fedeggarrido/SoftwareAgents.git
cd SoftwareAgents
npm install
npm run build
```

Press **F5** in VS Code for the Extension Development Host, or run `node dist/cli.js` for the
standalone office.

## Before opening a pull request

```bash
npm run compile                 # protocol generation, type checks, lint, bundles
npm test                        # server + webview Vitest
npm run e2e -- --workers=1      # Playwright, mock CLIs only
```

- Read [CLAUDE.md](CLAUDE.md) for the layering rules, the TypeScript constraints and the constants
  policy, and [CONTEXT.md](CONTEXT.md) for the vocabulary.
- Never edit `core/src/messages.ts` by hand: change `core/asyncapi.yaml` and regenerate.
- Tests must use isolated temporary homes and never touch the real `~/.claude`, `~/.codex` or
  `~/.pixel-agents`.
- Changes that touch execution authority (executors, hooks, permission profiles, human decisions)
  must respect the [threat model](docs/security/threat-model.md).
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` …).

By contributing, you agree that your work is licensed under the [MIT license](LICENSE).

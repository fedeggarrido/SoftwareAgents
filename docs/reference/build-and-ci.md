# Build, dev and CI

> Read before changing esbuild, scripts or CI. Moved verbatim from CLAUDE.md.

## Build & Dev

**npm workspaces monorepo** (`server`, `webview-ui`). A single `npm install` at the root installs deps for all workspaces; `cd webview-ui && npm install` is redundant.

```bash
npm install                # installs root + workspaces in one shot
npm run compile            # asyncapi:generate, check-types, lint, esbuild, vite
npm run build              # alias for compile
npm run package            # production build (esbuild --production)
npm test                   # webview + server vitest
npm run e2e                # Playwright
```

`esbuild.js` runs three bundles:

1. **Extension** (`dist/extension.js`) from `adapters/vscode/extension.ts`. External: `vscode`.
2. **CLI** (`dist/cli.js`) from `server/src/cli.ts`. Externals pulled at install time (`fastify`, `@fastify/*`).
3. **Hook scripts** (`dist/hooks/claude-hook.js`) from `server/src/providers/hook/claude/hooks/claude-hook.ts`. CJS, shebang.

`define: { 'process.env.PIXEL_AGENTS_VERSION': JSON.stringify(version) }` stamps the package version into all bundles.

**Watch mode**:

```bash
npm run watch                       # parallel esbuild watch + tsc --noEmit watch
cd webview-ui && npm run dev        # Vite dev server (separate terminal)
```

The webview Vite dev server is **not** included in `npm run watch` — it has to be run separately.

**F5 in VS Code** launches the Extension Development Host with the local extension loaded.

### CI

Single workflow runs (in order): install, lint, `asyncapi:validate`, `asyncapi:generate` + drift check, `e2e:inventory` + drift check, `check-types`, `test:server`, `test:webview`, `e2e` (3-OS x 3-shard matrix: Linux, macOS, Windows), `package`, then a PR-only Vercel preview deploy of the combined Allure report (gated on secrets; gracefully skips on forks, non-blocking on failure). Pushes to `main` run the checks but never deploy to Vercel.

The drift checks are the central guarantees: `core/asyncapi.yaml` ↔ `core/src/messages.ts` stay in lockstep; `e2e/README.md` stays in sync with the spec list.

## Fork CI cost (SA-066)

Measured on the first green fork runs (2026-11-03, run 41709001638), rounded up per job:

|                                                                                | Linux min | Windows min | Billable-equivalent (Windows ×2) |
| ------------------------------------------------------------------------------ | --------- | ----------- | -------------------------------- |
| Upstream matrix (Linux + Windows + macOS E2E, ×10 for macOS), estimate         | ~40       | ~45         | ~130 + macOS ~400                |
| Fork: Linux CI + npm smoke + 3 Linux E2E, 3 Windows E2E, 8 Windows unit shards | 39        | 123         | ~285                             |

- macOS was dropped (outside the fork's targets), which removed the largest cost.
- The Windows unit job is new: SA-032+ worktree and executor code must be tested on Windows.
- The repository is public, so GitHub-hosted minutes are free. The figures matter only if it goes private again.
- `update-badges` and `publish-extension` are disabled in the fork (`gh workflow disable`), and the Vercel preview is skipped without its secrets.

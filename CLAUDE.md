# Pixel Agents — Compressed Reference

Pixel art office where AI agents (Claude Code terminals today, any tool tomorrow) become animated characters. Ships as a **VS Code extension** and an **`npx pixel-agents` standalone CLI** from the same source tree.

`CONTEXT.md` is the canonical glossary — read it for what terms like Agent, Sub-agent, Teammate, Lead, Adopt, or Headless agent mean here, and use its vocabulary in code, comments, and docs.

For fork domain work, read [CONTEXT.md → SoftwareAgents](CONTEXT.md#softwareagents): Agent = a persistent AgentSpec instance in a Project; Session / Character describe the legacy CLI / visual concepts. Agent ≠ Model. Existing code identifiers retain their legacy meaning; [ADR-0002](docs/adr/0002-evolucion-incremental-del-fork.md) defines the incremental scope.

## Layering (hard rule)

`core/` depends on nothing; `server/` depends only on `core/`; `webview-ui/` depends only on `core/`; `adapters/vscode/` depends on `core/` and `server/`. The standalone CLI never imports `adapters/vscode/` and vice versa. Protocol = `core/asyncapi.yaml` (AsyncAPI 3.0, generated `core/src/messages.ts`, never edit by hand; CI drift check). Hub-and-spoke: server aggregates hooks + JSONL into `AgentEvent` → `AgentRuntime` → `AgentStateStore` → transport (`PostMessageTransport` in VS Code, `WebSocketTransport` standalone). Read the [threat model](docs/security/threat-model.md) before launching Executors or changing execution authority.

## Commands

```bash
npm install            # root + workspaces (no separate webview-ui install)
npm run compile        # asyncapi:generate, check-types, lint, esbuild, vite
npm run check-types
npm test               # webview + server vitest (test:server / test:webview)
npm run e2e -- --workers=1 [--grep "<name>"]   # Playwright; mock claude only
npm run e2e:inventory  # regen e2e/README.md (CI drift check)
```

## Security rules

- ClickUp writes: REST API (`https://api.clickup.com/api/v2`) with `CLICKUP_TOKEN` env var ONLY — never in files, commits, logs, memory or Codex prompts. The MCP connector caps at 100 calls/day; use it for occasional reads.
- Tests and e2e use isolated `tmpHome`/workspaces; never write to the real `~/.claude`, `~/.codex` or `~/.pixel-agents` profiles.
- The workspace never authorizes a command; hook install is consent-gated; never rewrite a settings shape we did not author (see [key-decisions](docs/reference/key-decisions.md)).
- Work in git worktrees per task; Claude ↔ Codex workflow in [AGENTS.md](AGENTS.md).

## Fork modules (short list; details in [fork-modules](docs/reference/fork-modules.md))

Runtime (`server/src/`): `boardWatcher`, `codexWatcher`, `companyControl`, `quotaReader`, model tiers/policy/admission (`modelTiers`, `modelPolicy`, `modelTierAdmission`, `taskModelInputs`, `quotaCommand`), `worker`, `domainEventRelay`, `agentRoles`, `executorState`/`executorAvailability`/`executorProbes`, `telemetry` (SA-095). Panels (`webview-ui/src/components/`): `CompanyHud`, `BacklogPanel`, `DecisionsPanel`, `MeetingPanel`, `ExecutorPanel`. AgentSpec v1alpha1 permission profiles: `core/src/agentSpec.ts`. These project Sessions/work into the office; they grant no permissions.

## Where to find X (read the file BEFORE touching that area)

| Area                                                                                       | File                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layer tree, communication flow, transports, AgentRuntime, store, persistence, distribution | [architecture](docs/reference/architecture.md)                                                                                                                                                                                                                 |
| Fork company modules, executor selection panels, AgentSpec profiles                        | [fork-modules](docs/reference/fork-modules.md)                                                                                                                                                                                                                 |
| AsyncAPI contract, SA-029/035/087–092 message design                                       | [protocol](docs/reference/protocol.md)                                                                                                                                                                                                                         |
| HookProvider, TeamProvider, teammates, sub-agents, sidecars                                | [teams](docs/reference/teams.md)                                                                                                                                                                                                                               |
| `/ws` gating, server discovery, residual risks                                             | [discovery](docs/reference/discovery.md)                                                                                                                                                                                                                       |
| JSONL parsing, hook vs heuristic modes, timers                                             | [agent-status](docs/reference/agent-status.md)                                                                                                                                                                                                                 |
| Context gauge (`contextUsage.ts`)                                                          | [context-usage](docs/reference/context-usage.md)                                                                                                                                                                                                               |
| Canvas, characters, layout editor, asset system                                            | [office-ui](docs/reference/office-ui.md)                                                                                                                                                                                                                       |
| Vitest/Playwright tiers, mock claude, e2e rules                                            | [testing](docs/reference/testing.md)                                                                                                                                                                                                                           |
| esbuild bundles, watch mode, CI                                                            | [build-and-ci](docs/reference/build-and-ci.md)                                                                                                                                                                                                                 |
| Hook installer, consent flow, hook identity, key decisions                                 | [key-decisions](docs/reference/key-decisions.md), [ADR-0001](docs/adr/0001-consent-choices-send-immediately-and-revise-as-absolute-state.md), [ADR-0002](docs/adr/0002-evolucion-incremental-del-fork.md), [ADR-0003](docs/adr/0003-workstore-sqlite-local.md) |
| Error handling, logging, lessons, manual hook testing, tileset import                      | [lessons-and-misc](docs/reference/lessons-and-misc.md)                                                                                                                                                                                                         |

## TypeScript Constraints

- **No `enum`** (`erasableSyntaxOnly` in webview) — use `as const` objects (`TileType`, `CharacterState`, `Direction`, `EditTool`).
- **`import type`** required for type-only imports (`verbatimModuleSyntax` in webview; convention in extension).
- **`noUnusedLocals` / `noUnusedParameters`** — strict everywhere.
- **`.js` extensions** on all relative imports in extension + server (Node16 module resolution).
- **Module Node16, target ES2022** in the extension/server. **`erasableSyntaxOnly`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`** in the webview.

## Constants Policy

All magic numbers and strings are centralized — never inline:

| Where                              | What lives there                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/constants.ts`          | All timing/scanning constants (`PERMISSION_TIMER_DELAY_MS`, `TEXT_IDLE_DELAY_MS`, scanner intervals) shared by extension and standalone |
| `adapters/vscode/constants.ts`     | VS Code-only IDs, command names, workspace state keys                                                                                   |
| `core/src/constants.ts`            | Protocol-level constants (e.g., transport state names)                                                                                  |
| `webview-ui/src/constants.ts`      | Webview magic numbers (grid, animation, rendering, camera, zoom, editor, game logic) + canvas overlay rgba strings                      |
| `webview-ui/src/index.css` `:root` | CSS custom properties (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, ...) for React inline styles and CSS                           |
| `webview-ui/src/office/types.ts`   | Re-exports grid constants from `constants.ts` for convenience                                                                           |

## Project Identity

- Extension ID: `pablodelucca.pixel-agents` (VS Code Marketplace + Open VSX)
- npm package: `pixel-agents` (CLI bin: `pixel-agents`)
- GitHub: `https://github.com/pixel-agents-hq/pixel-agents`
- License: MIT

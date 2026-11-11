# Testing

> Read before writing or running tests. Moved verbatim from CLAUDE.md.

## Testing

Three tiers, each with its own framework.

### Server unit/integration (Vitest)

`server/__tests__/` covers the shared runtime, persistence, providers, HTTP/WebSocket server, CLI, diagnostics, asset reloads, and the e2e scenario runner. Representative suites include:

| File                           | Coverage                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentStateStore.test.ts`      | Mutations, EventEmitter events, snapshot                                                                                                       |
| `hookEventHandler.test.ts`     | Routing, buffering, normalized dispatch, team gating                                                                                           |
| `sessionRouter.test.ts`        | session_id mapping, pending sessions, buffer flush                                                                                             |
| `fileWatcherDismissal.test.ts` | DismissalTracker integration                                                                                                                   |
| `fileStateAdapter.test.ts`     | Namespaced persistence, allowlist, settings round-trip                                                                                         |
| `migrateVsCodeState.test.ts`   | Verify-before-clear, partial migration                                                                                                         |
| `teamUtils.test.ts`            | Inline-teammate helpers                                                                                                                        |
| `claudeTeamProvider.test.ts`   | Discovery, membership, metadata extraction                                                                                                     |
| `claude.test.ts`               | `normalizeHookEvent` per Claude event, file fallback                                                                                           |
| `claudeHookInstaller.test.ts`  | Atomic install/uninstall, unparseable-file + non-array abort, throwing writes, mode preservation, backup, hook identity, event-scope migration |
| `consentFlow.test.ts`          | In-app consent over the wire: who is asked, what each answer writes, Back-and-revise semantics, answer serialization                           |
| `claude-hook.test.ts`          | Spawned hook script integration (needs `dist/hooks/claude-hook.js`)                                                                            |
| `server.test.ts`               | HTTP lifecycle, auth, `/ws`, broadcast                                                                                                         |
| `httpServerWs.test.ts`         | `/ws` gate: standalone same-origin, embedded Bearer                                                                                            |
| `mockClaudeRunner.test.ts`     | E2E scenario runner sanity                                                                                                                     |

Run: `npm run test:server` (or `npm test` for all).

### Fresh worktrees (SA-QA-58)

`developerCli.test.ts` builds the real containment hook from the current worktree
before launching its fake CLIs. Dependency junctions supply packages, but do not
supply ignored `dist/` artifacts. Without `dist/hooks/containment-hook.js`,
`ClaudeCliExecutor` refuses launch, so even `feature spec` fails with
`category=containment` before the Developer verifier runs. This was the cause of
the fresh-worktree failures; neither the dependency junction nor the fake CLI's
`__dirname` escaped containment. Never borrow another checkout's hook or disable
the mandatory check to make these tests pass.

### Webview unit (Vitest, Node runner)

`webview-ui/test/` covers office state, layout editing and migration, assets, changelog behavior, and Vite/browser wiring.

Run: `npm run test:webview`.

### End-to-end (Playwright)

`e2e/` contains Playwright tests against a real VS Code Electron instance and a standalone Fastify server. CI runs the suite on Linux and Windows in three shards at `--workers=1`. macOS is outside the fork's supported targets (the worker requires Windows). The generated [e2e inventory](../../e2e/README.md) is the source of truth for current specs, scenarios, and `@area:` coverage.

**Mock claude**: Tests never invoke real `claude`. A bash script (`e2e/fixtures/mock-claude`) is copied into an isolated `bin/` and prepended to `PATH`. The scenario runner (`mock-claude-runner.cjs`) honors `claudeScenario(...).at(ms).appendJsonl(record).emitHook(event).holdOpenFor(ms).build()` to drive timed JSONL writes and hook events.

**Authoring rules (normative)**: before writing a new spec, read `e2e/README.md` → "Mocking model & rules". It is the single source of truth for the process-boundary principle, the append-only transcript rule, the assert-on-visible-outcomes discipline, and the one standalone-server exception. New tests must follow that model.

**Isolation**: each test gets its own `tmpHome`, workspace directory, VS Code `--user-data-dir`, and mock-log file. No state leaks between tests.

**Auto-fixtures**: `_allureLabels` (auto: true) reads `@area:<tag>` from `testInfo.tags` and applies the corresponding Allure epic.

**Single source of truth for test inventory**: `e2e/README.md` contains an auto-generated section spliced between `<!-- BEGIN:E2E-INVENTORY -->` and `<!-- END:E2E-INVENTORY -->` markers. CI regenerates via `npm run e2e:inventory` and fails on `git diff --exit-code e2e/README.md`.

Run:

```bash
npm run e2e                                    # all tests
npm run e2e -- --workers=1                     # single worker (matches CI sharding)
npm run e2e -- --grep "lifecycle"              # filter by name
npm run e2e:debug                              # step-through
npm run e2e -- --attach-videos-on-success      # keep videos for passes too
npm run e2e:inventory                          # regen e2e/README.md inventory
npm run test:report                            # build combined Allure report
npm run test:report:open                       # serve Allure locally (file:// can't fetch)
```

**Reproducing CI failures locally**: CI uses `--workers=1` because the runners can't handle more. Reproduce locally with `npm run e2e -- --workers=1 --grep "<test>"`. For full Linux fidelity, `act -j linux-e2e --matrix shard:1 -P ubuntu-latest=catthehacker/ubuntu:full-22.04 --container-architecture linux/amd64` or run inside `mcr.microsoft.com/playwright:v1.58.2-noble` Docker with `--cpus=2 --memory=4g` to simulate runner throttling.

## Design guards (SA-151)

`e2e/tests/standalone/design-guards.spec.ts` (`@area:design`) sweeps every screen at 1440×900 and 375×812 with computed-style rules from `e2e/helpers/designGuards.ts`: text size, WCAG AA contrast, Spanish UI without jargon (deny list in the helper), mid-word wraps, horizontal overflow, 44 px touch targets on mobile, motion (no `transition: all`, no `ease-in`, ≤ 300 ms, reduced-motion respected), mobile layers and the single connection notice of SA-154. Known violations live in `e2e/design-guards.baseline.json`, each with a reason. A new violation fails, and so does a fixed one still listed, so the list only shrinks. After a reviewed burn-down, regenerate it with `PIXEL_AGENTS_DESIGN_BASELINE=write npm run e2e -- --grep @area:design` (new env var, e2e only).

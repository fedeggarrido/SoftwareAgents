# HTTP/WS server and server discovery

> Read before touching httpServer, /ws gating or ~/.pixel-agents/servers discovery. Moved verbatim from CLAUDE.md.

### HTTP + WebSocket Server

Fastify v5 with `@fastify/cors`, `@fastify/websocket`, and (in standalone) `@fastify/static`:

| Method | Path                     | Purpose                                 |
| ------ | ------------------------ | --------------------------------------- |
| POST   | `/api/hooks/:providerId` | Bearer-authenticated hook event ingress |
| GET    | `/api/health`            | Liveness: `{ status, uptime, pid }`     |
| GET    | `/ws`                    | Bidirectional protocol channel          |
| GET    | `/*` (standalone only)   | Webview SPA via `@fastify/static`       |

`/ws` is gated in **two tiers**, because `setHooksEnabled(true)` over this socket is a durable, machine-wide consent grant plus a hook install.

1. **Connection** (`isAllowedWebSocketOrigin`): embedded requires the Bearer token; standalone requires a same-origin handshake. A missing Origin still connects (non-browser clients send none). This tier is weak by design — a DNS-rebound page sends `Origin` and `Host` as the same attacker-chosen name and IS accepted (`httpServerWs.test.ts` pins that).
2. **Privileged messages** (`standaloneTokenValid`, `ClientMessageContext.privileged`): proved by an out-of-band secret — embedded via its Bearer token, standalone via the server token in the `/ws` `?token=` query, which the CLI prints in the local URL and the SPA forwards (`webview-ui/src/transport/index.ts`). **Never a network position**: peer address, `Host` and `Origin` all ride the channel a proxy speaks, so a LAN-bound forwarder piping bytes to 127.0.0.1 satisfies all three. The token is a replayable bearer capability, not evidence of locality — it also reaches browser history and Fastify's request log, so the printed URL is documented to the user as a secret. An untokened client still watches the office; it just cannot change `~/.claude/settings.json`.

The **hooks preference is persisted only after the install/uninstall settled and the on-disk result agrees** — writing it first strands the user when an uninstall fails: entries still firing, but a persisted hooks-off makes the next startup skip the consent/install path entirely.

Server discovery written to `~/.pixel-agents/server.json` (legacy pointer) and `~/.pixel-agents/servers/<pid>-<port>.json` (registry) with `{ port, pid, token, servesSpa, ... }`. Multi-window safe: a starting server reuses a registered one only if its PID is alive AND `/api/health` on its port answers with that same PID — Windows recycles PIDs, so a crashed server's entry can name an unrelated live process (SA-076). Refused or answered by someone else = stale: the entry and a `server.json` naming it are pruned. A probe timeout (busy server) is neither reused nor pruned.

Discovery (SA-QA-6): the shared probe enforces a total deadline (1500 ms for reuse;
300 ms for the hook's legacy fallback) and rejects bodies exceeding 4096 characters.
Registry hook fan-out does not add a probe per event. Records may carry a validated
local literal contact IP (`host`); missing `host` retains 127.0.0.1 compatibility.
The contact IP comes from the actual bind; wildcard IPv4/IPv6 use 127.0.0.1/::1.
Publication and generation-specific cleanup (token + startedAt + PID + port, also
host) share an exclusive-create lock in servers/, with a 300 ms contention bound
and a 10 s mtime lease (SERVER_DISCOVERY_LOCK_LEASE_MS). HTTP probes never hold
this lock; critical sections must finish within the lease. A dead owner or an
expired lease is reclaimed regardless of PID life or incomplete/invalid contents.
Recovery elects one reaper per generation; .reaped-<nonce>.lock tombstones prevent
a delayed second reaper from unlinking a new lock. Dead or expired tombstones
(including corrupt ones) elect a successor. Recovery is automatic on the next
acquisition; a failed lock-body write also releases the creator's own entry.
The registry is published first and independently of server.json. Windows
EPERM/EBUSY renames get short retries; unfinished publication retries in the
background with 100 ms to 5 s backoff until success or stop(). When locking fails,
discovery scans read-only without pruning. A live entry whose host is temporarily
absent from local interfaces is skipped for reuse and hook fan-out, and retained.
Mutations contain the parent with pathGuard.resolveInside, operate on lexical
entries, and leave final symlinks alone. Unique exclusive-create temporaries are
cleaned on failure. The directory is operator-owned: 0700 on creation and
record/lock files 0600 on POSIX; Windows uses inherited profile ACLs. This does not
repair permissive existing ACLs, and the cooperative lock cannot constrain old
versions or an adversary replacing filesystem links between validation and use.

Residual discovery risk: registry fan-out sends the Bearer token and event payload
to destinations with **only PID-liveness validation, without a health probe**.
A recycled live PID and reused port can therefore send events to an unrelated
local listener until a server start prunes the stale generation. The legacy
fallback requires a live PID and excludes generations just rejected as dead;
its 300 ms probe is **liveness, not authentication**. Only a stale verdict blocks
delivery: any listener that neither refuses nor answers wrongly within 300 ms
(busy, stalled or resetting) still gets the POST with its 2 s timeout, and stalling
registry targets are not pruned. "Live" means anything but ESRCH, in the hook as in
the server: an EPERM PID (an elevated server, or a SYSTEM process that reused a
crashed server's PID) counts as alive. A local
process can imitate /api/health and receive legacy tokens and events. Nonce/HMAC
authentication without disclosing the token during the probe is deferred. An OS
pause longer than the 10 s lease can allow overlapping cooperative critical
sections; recovery tombstones remain on disk. Concurrent starts may create separate
servers, each publishing after listen with its own PID/port entry. Permanent
filesystem/ACL failures still prevent publication despite retries. The legacy
single pointer reaches at most one server during mixed-version operation.

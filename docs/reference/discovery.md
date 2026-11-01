# HTTP/WS server and server discovery

> Read before touching httpServer, /ws gating or ~/.pixel-agents/servers discovery. Moved verbatim from CLAUDE.md.

### HTTP + WebSocket Server

SA-075: Fastify redacta los valores query `token` (también claves codificadas y
repetidas) en HTTP y upgrades WS; las cabeceras Authorization se omiten del
serializador de petición y se redactan si se registran explícitamente. No se
registran mensajes WS controlados por el cliente. AuditLog ya redacta tokens y
Authorization. La URL impresa por el CLI sigue siendo un secreto intencional.

`pixel-agents token rotate [--port PORT]` rota la instancia señalada por
server.json, o la entrada de registro del puerto explícito. Requiere el Bearer
vigente, comprueba salud/PID, rechaza Origin de navegador y audita la autorización
en el audit de máquina sin secretos. Genera un UUID nuevo, invalida Bearer/query
anteriores y desconecta todos los WS (incluidos los de VS Code); reconectar exige
leer discovery de nuevo para recuperar privilegios. Los clientes standalone sin
token conservan acceso de lectura. Los hooks que leen discovery usan el nuevo
token en la siguiente entrega; consumidores que lo cacheen deben releerlo.
Ambos records se republicarán usando escrituras 0600 y el lock existente;
fallos de publicación se registran y reintentan con el mecanismo habitual.
En Windows se conservan las ACL heredadas del perfil. Cada arranque de una
instancia nueva genera otro UUID; reutilizar una instancia no es un arranque.
La decisión de conservar temporalmente query está en [ADR-0005](../adr/0005-server-token-transport.md).

Fastify v5 with `@fastify/cors`, `@fastify/websocket`, and (in standalone) `@fastify/static`:

| Method | Path                     | Purpose                                 |
| ------ | ------------------------ | --------------------------------------- |
| POST   | `/api/hooks/:providerId` | Bearer-authenticated hook event ingress |
| GET    | `/api/health`            | Liveness: `{ status, uptime, pid }`     |
| GET    | `/ws`                    | Bidirectional protocol channel          |
| GET    | `/*` (standalone only)   | Webview SPA via `@fastify/static`       |

`/ws` is gated in **two tiers**, because `setHooksEnabled(true)` over this socket is a durable, machine-wide consent grant plus a hook install.

1. **Connection** (`isAllowedWebSocketOrigin`): embedded requires the Bearer token; standalone requires a same-origin handshake. A missing Origin still connects (non-browser clients send none). This tier is weak by design — a DNS-rebound page sends `Origin` and `Host` as the same attacker-chosen name and IS accepted (`httpServerWs.test.ts` pins that).
2. **Privileged messages** (`standaloneTokenValid`, `ClientMessageContext.privileged`): proved by an out-of-band secret — embedded via its Bearer token, standalone via the server token in the `/ws` `?token=` query, which the CLI prints in the local URL and the SPA forwards (`webview-ui/src/transport/index.ts`). **Never a network position**: peer address, `Host` and `Origin` all ride the channel a proxy speaks, so a LAN-bound forwarder piping bytes to 127.0.0.1 satisfies all three. The token is a replayable bearer capability, not evidence of locality — it still reaches browser history and the operator's terminal, so the printed URL is a secret. Fastify request logs redact it from SA-075 onward. An untokened client still watches the office; it just cannot change `~/.claude/settings.json`.

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

### Confirmación humana en CLI (SA-107)

Abra primero la oficina del Project. Los comandos que registran decisiones humanas
exigen el token de la instancia seleccionada por `~/.pixel-agents/server.json`
(el mismo puntero predeterminado de `pixel-agents token rotate`). La instancia
debe seguir viva. El servidor es compartido entre Projects: discovery no publica
un token distinto por Project. Si hay varias oficinas, compruebe cuál señala ese
puntero; el token de otra instancia no confirma el comando.

Ejemplo: `pixel-agents feature approve FEAT-001 --confirm`. Pegue solo el token
de la URL privilegiada de esa oficina cuando aparezca el prompt oculto. `--confirm`
va al final, no recibe un valor y requiere stdin y stderr TTY. Ctrl+C, Ctrl+D o
fin de entrada cancelan; no se admite un pipe. No pegue el token en argv ni en
archivos del Project. También puede proporcionar `PIXEL_AGENTS_OPERATOR_TOKEN`
en el entorno privado del operador; si existe, se usa incluso con `--confirm`.
No la configure en scripts del repo, perfiles de Agents ni logs. Los hijos de
Executors, autopilot, sondas y bootstrap la eliminan explícitamente.

Se aplica a `feature run|approve|rebase`, `feature spec|design --answers`,
`review finding --accept|--reject`, `learning approve|reject`, `task retry`,
`design review|direction|apply-direction`, `research run`, `worker run` directo,
`eval run` (también con `--yes`) y `usage backfill` sin `--dry-run`.
Las etapas internas sin decisión humana, la admisión explícita de
companyAutopilot y las lecturas conservan sus reglas. DecisionsPanel sigue usando
el WS privilegiado. Tras rotar el token, vuelva a abrir discovery y actualice
la variable si la usa. Los fallos de confirmación no registran decisiones.

Esta medida evita la suplantación basada solo en borrar marcadores. No evita que
otro proceso con los permisos del operador lea discovery: véase
[threat-model §9](../security/threat-model.md#9-ingreso-humano-con-token-privilegiado-sa-107).

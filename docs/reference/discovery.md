# HTTP/WS server and server discovery

> Read before touching httpServer, /ws gating or ~/.pixel-agents/servers discovery. Moved verbatim from CLAUDE.md.

### HTTP + WebSocket Server

SA-075: Fastify redacta los valores query `token` (también claves codificadas y
repetidas) en HTTP y upgrades WS; las cabeceras Authorization se omiten del
serializador de petición y se redactan si se registran explícitamente. No se
registran mensajes WS controlados por el cliente. AuditLog ya redacta tokens y
Authorization. Desde SA-144 el CLI imprime únicamente la dirección pública.
El arranque humano requiere stdin y stdout TTY para abrir el navegador. No abre
con CI, VITEST, PLAYWRIGHT, NODE_ENV=test, PIXEL_AGENTS_NO_OPEN, los marcadores
gestionados existentes ni `--no-open`.

El lanzador recibe `/?open=<código aleatorio>`, nunca el token persistente.
`POST /api/office/open` requiere Bearer, proceso humano y petición sin Origin;
crea un código de 32 bytes que caduca en 60 segundos (constantes del servidor).
La SPA retira `open` con `replaceState` antes de esperar la red y lo intercambia
una vez por el token con `POST /api/office/exchange`. No reintenta el intercambio.
Ambas rutas requieren peer y Host loopback, rechazan Origin ajeno y comparten
un límite por proceso de 20 peticiones por minuto, incluidas las fallidas.
Las respuestas usan no-store; los códigos solo existen en memoria, se invalidan
con la rotación y se redactan en logs, también en queries repetidas o codificadas.
Un fallo de intercambio deja el acceso habitual de lectura.

SA-116 captura el token de la navegación inicial una sola vez, antes de conectar,
y elimina todos los parámetros `token`, incluidos los repetidos o con la clave
codificada, con `history.replaceState`. Conserva el resto de la ruta, query,
fragmento y estado del historial. Solo la URL del transporte en memoria conserva
la capacidad para el handshake WS y sus reconexiones. El cliente no persiste el
token en almacenamiento del navegador ni vuelve a obtenerlo de `location`.
Recargar la página pierde esa capacidad. Abrir Pixel Agents de nuevo desde una
terminal interactiva humana vuelve a abrir la oficina autenticada. Una pestaña
que permanece abierta recupera la conexión tras reiniciar el programa.

El handshake `webviewReady` recibe `officeAccess` con el privilegio de esa conexión
y un motivo cerrado `token_required`, `managed_process` o null. En standalone
incluye también `persistent`, una señal informativa para el aviso de Settings
cuando la protección de credenciales obliga al acceso por ejecución. No contiene
identidades, marcadores, rutas ni contenido. La barra muestra «Solo lectura» u
«Operador», con una explicación accesible por clic y tooltip. Un servidor iniciado
por un agente muestra «Operador · proceso gestionado» cuando el token es válido y
explica el bloqueo de preparación y guardado. La UI trata la lectura denegada de
ideas como información de acceso y abre esa explicación antes de la entrevista.
VS Code obtiene el modo operador de su canal integrado, sin token en la URL.
La señal de UI conserva los controles de autoridad existentes en el servidor.

Riesgo residual de SA-116. La retirada de la barra sustituye la entrada actual del
historial, pero no garantiza borrar copias previas, sincronizadas o capturadas
antes de ejecutar JavaScript. Las navegaciones nuevas llevan solo el código;
discovery,
la memoria de la página y las peticiones WS visibles en herramientas del navegador
siguen manejando el secreto. El token sigue siendo bearer y reutilizable. Evitar
mostrarlo en la barra reduce la exposición en capturas posteriores, sin revocarlo.
Los logs de Fastify mantienen la redacción de SA-075. Un proceso del mismo usuario
del SO conserva el riesgo de acceso a memoria y discovery descrito en el modelo
de amenazas.

SA-144 guarda la capacidad standalone por usuario en
`~/.pixel-agents/office-access.json`, fuera del workspace. Se crea bajo el lock
de discovery, con temporal exclusivo, fsync y publicación atómica. POSIX usa
0600 y el directorio de usuario se crea 0700. En Windows se consulta el SID con
`whoami` y se aplica `icacls /inheritance:r /grant:r *SID:(F)` antes de escribir
el secreto. Get-Acl verifica una DACL protegida con una sola regla explícita
Allow FullControl para ese SID. Fallos de identidad, aplicación o verificación
activan un token aleatorio por ejecución, sin publicar el secreto sin protección.
Las copias standalone de discovery pasan por la misma protección antes de escribir;
si falla, no se publican y el descubrimiento de hooks/CLI queda indisponible.
Settings avisa en español de que el acceso no sobrevivirá a los reinicios.
El token nunca se imprime. Con protección verificada, sobrevive a reinicios y el
mismo archivo guarda el puerto predeterminado para que la pestaña alcance el
servidor reiniciado. Un puerto guardado ocupado provoca un error de arranque.
`--port` permite seleccionar otro puerto explícitamente.

La continuación de ideas y los comandos del tour quedan dentro de «Detalles»
cerrados. Para la confirmación CLI, Settings → Detalles → «Copiar token para CLI»
copia la capacidad en memoria solo al pedirlo el operador; no la muestra ni
la incorpora al comando. No se obtiene de la URL impresa.
Los borradores conservan texto, respuestas y proyecto de origen al reconectar.
Si llega un proyecto distinto, se bloquea guardar con «Este borrador era para
otro proyecto (X)» y se ofrecen «Descartar» y «Copiar texto».

`pixel-agents token --rotate` revoca la capacidad persistente incluso con el
programa cerrado. Settings ofrece «Revocar acceso de esta pestaña» y confirma
que afecta a todas las pestañas. El mensaje WS `rotateOfficeToken` exige el
privilegio de la conexión y un proceso humano sin marcadores gestionados.
Ninguna respuesta contiene el secreto nuevo. Cada instancia standalone relee
la capacidad antes de autorizar peticiones o mensajes, y un sondeo cada segundo
desconecta sockets antiguos incluso inactivos. Discovery se republica mediante
el escritor restringido y sus reintentos. Los hooks que leen discovery reciben
el token nuevo en la siguiente entrega. Consumidores que lo cachean deben
releerlo. Los clientes sin token conservan sus lecturas existentes.

El alias anterior `token rotate [--port PORT]` conserva la selección por
server.json o puerto, Bearer, comprobación salud/PID, rechazo de Origin y audit
sin secretos. Ahora también rechaza procesos gestionados. VS Code mantiene
tokens efímeros por instancia y su revocación específica mediante ese alias.
La decisión de conservar query está en [ADR-0005](../adr/0005-server-token-transport.md).

Riesgo residual aceptado de SA-144. Una copia robada de la capacidad standalone
sigue siendo válida después de reiniciar, hasta una revocación explícita. Todas
las oficinas standalone del usuario comparten esa capacidad. Se mantienen bind
loopback predeterminado, opciones explícitas de host y los gates de Origin,
Bearer y privilegio. El secreto sigue visible en memoria, navegación inicial,
herramientas de red, discovery y argumentos del lanzador del navegador. Un
proceso del mismo usuario conserva acceso potencial. La ACL del archivo nuevo
no endurece otras copias de discovery ni reemplaza la separación de SO de SA-058.
Un listener local que suplante el puerto guardado puede recibir el token de una
pestaña que reintenta. El handshake WS no autentica al servidor.
No se recupera privilegio de una pestaña sin capacidad por un endpoint público.

La UI muestra el backoff y permite «Reintentar ahora». Cada nueva conexión
repite `webviewReady`, invalida snapshots y reconstruye el roster sin recargar.
Los errores ofrecen Settings y el formulario SA-114 cuando procede. Si el
programa está cerrado, la página pide abrir Pixel Agents y deja un único
`npx pixel-agents` en «Detalles» plegados. La página no puede iniciar el proceso.

Fastify v5 with `@fastify/cors`, `@fastify/websocket`, and (in standalone) `@fastify/static`:

| Method | Path                     | Purpose                                 |
| ------ | ------------------------ | --------------------------------------- |
| POST   | `/api/hooks/:providerId` | Bearer-authenticated hook event ingress |
| GET    | `/api/health`            | Liveness: `{ status, uptime, pid }`     |
| GET    | `/ws`                    | Bidirectional protocol channel          |
| GET    | `/*` (standalone only)   | Webview SPA via `@fastify/static`       |

`/ws` is gated in **two tiers**, because `setHooksEnabled(true)` over this socket is a durable, machine-wide consent grant plus a hook install.

1. **Connection** (`isAllowedWebSocketOrigin`): embedded requires the Bearer token; standalone requires a same-origin handshake. A missing Origin still connects (non-browser clients send none). This tier is weak by design — a DNS-rebound page sends `Origin` and `Host` as the same attacker-chosen name and IS accepted (`httpServerWs.test.ts` pins that).
2. **Privileged messages** (`standaloneTokenValid`, `ClientMessageContext.privileged`) use an out-of-band secret, carried as Bearer in embedded and `/ws?token=` in standalone. Human interactive startup hands a single-use 60-second bootstrap code to the browser opener. The SPA clears the page URL, exchanges the code over loopback and retains the capability in memory. Peer address, Host and Origin remain reproducible by a forwarder; the code is still required. The persistent bearer remains replayable until rotation. Fastify redacts credentials and codes. Untokened clients keep their existing read surface.

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
debe seguir viva y demostrar que conoce el token mediante un HMAC de un nonce
nuevo y su PID, sin recibir el token del cliente. Esta comprobación usa
`discoveryRoot()` y `os.homedir()`, igual que el resto de discovery, respetando
`HOME` o `USERPROFILE` según el SO.
Solo contacta con `127.0.0.1`; una instancia sin ese listener, una versión sin
la ruta de prueba o cualquier error/timeout deniega la confirmación.
El servidor es compartido entre Projects: discovery no publica
un token distinto por Project. Si hay varias oficinas, compruebe cuál señala ese
puntero; el token de otra instancia no confirma el comando.

Ejemplo: `pixel-agents feature approve FEAT-001 --confirm`. El token pertenece al
estado privado del usuario y a discovery. Introdúzcalo en el prompt oculto. `--confirm`
va al final, no recibe un valor y requiere stdin y stderr TTY. Ctrl+C, Ctrl+D o
fin de entrada cancelan; no se admite un pipe. No pegue el token en argv ni en
archivos del Project. También puede proporcionar `PIXEL_AGENTS_OPERATOR_TOKEN`
en el entorno privado del operador; si existe, se usa incluso con `--confirm`.
No la configure en scripts del repo, perfiles de Agents ni logs. Los hijos de
Executors, autopilot, sondas, bootstrap, git, verificadores y limpieza la eliminan
explícitamente después de fusionar overrides; VS Code la anula en los terminales.

Se aplica a `feature run|approve|rebase`, `feature spec|design --answers`,
`review finding --accept|--reject`, `learning approve|reject`, `task retry`,
`design review|direction|apply-direction`, `research run`, `worker run` directo,
`eval run` (también con `--yes`) y `usage backfill` sin `--dry-run`.
Las etapas internas sin decisión humana, la admisión explícita de
companyAutopilot y las lecturas conservan sus reglas. DecisionsPanel sigue usando
el WS privilegiado. Tras rotar el token, vuelva a abrir discovery y actualice
la variable si la usa. Los fallos de confirmación no registran decisiones.

Un agente que se ejecute con el mismo usuario del SO puede borrar los marcadores
gestionados, falsificar discovery y levantar su propio servidor de prueba para
superar la confirmación. Los marcadores, la contención del Executor,
`protectedPaths` y el filtrado del entorno mitigan este riesgo residual. La
separación efectiva requiere una identidad de SO distinta, pendiente en SA-058.
Véase
[threat-model §9](../security/threat-model.md#9-ingreso-humano-con-token-privilegiado-sa-107).

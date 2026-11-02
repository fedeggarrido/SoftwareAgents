# Threat model inicial de SoftwareAgents

SA-067 · 2026-10-02 · Alcance: ejecución local supervisada mediante Executors
Claude Code y Codex, según [ADR-0002](../adr/0002-evolucion-incremental-del-fork.md)
y el [glosario SoftwareAgents](../../CONTEXT.md#softwareagents).
Este documento registra riesgos y condiciones de revisión; no implementa mitigaciones
ni acredita aislamiento. Revisado por Claude (2026-10-02).

Se protegen los archivos y procesos del host, las credenciales del Operator, la
integridad del Project Brain y del trabajo, y la disponibilidad de la cuenta.
Fundtrinsic queda fuera del alcance: no se inspeccionan ni modifican sus archivos,
datos o procesos. Las fronteras de confianza son contenido → runtime, runtime →
Executor/herramientas, rama → CI y propuesta → Human Decision.

## SA-108: descubrimiento y fuentes sin claves

Inventario añadido: `server/src/webScout.ts`, `agents/templates/web-scout.yaml` y
`server/src/researchAdapters/youtube.ts`; Reddit público amplía `reddit.ts`.
Web-scout usa exclusivamente WebSearch de Claude, read_only, sin WebFetch, lectura
de archivos, shell, MCP ni delegación; Codex no admite este rol. El compilador exige
solo una pregunta acotada y un esquema de salida, sin Brain ni repository. Claude se
lanza en cwd privado, sistema propio y sin persistencia de sesión, con
`claudeMdExcludes: ["**"]`, `autoMemoryEnabled: false`, skills deshabilitadas,
settings sources vacíos y MCP estricto. No usa `--bare` porque impide OAuth de
suscripción; conserva los hooks de contención. Rechaza CLAUDE.md gestionado local,
que no admite exclusión. Esta excepción no abre la web al
Researcher ni a los demás roles. El tripwire rechaza cualquier otra herramienta.
La frontera del scout depende de la lista explícita de tools y del CLI, no de un
sandbox de SO. Validar compatibilidad de las exclusiones en QA real; políticas
gestionadas remotas del Operator siguen siendo una frontera de confianza y no
deben añadir contexto privado. Referencia:
[memoria de Claude Code](https://code.claude.com/docs/en/memory) y
[modo programático y limitación OAuth de bare](https://code.claude.com/docs/en/headless).

La salida completa debe ser JSON estricto con lista acotada (hasta 12), sin campos
extra; se validan URLs HTTP(S) sin credenciales. Solo se conservan URLs: título y
motivo nunca se pasan al Researcher. El runtime vuelve a descargar por researchHttp
con DNS pinning, límites y validación SSRF. Reddit público y YouTube usan la misma
frontera HTTP y makeSource: cada SourceItem entero sigue siendo untrusted-external.
YouTube lee página y subtítulos públicos únicamente; no vídeo. Reddit comparte
pacing por proceso y suspende una hora tras errores, incluido 429.

Riesgo residual: WebSearch recibe la pregunta y puede emitir URLs controladas por
contenido hostil; consultas y URLs pueden transportar su texto a terceros. No dar
secretos ni datos privados al scout: solo la pregunta pública. WebFetch está denegado;
habilitarlo permitiría exfiltración directa por URL y exigiría mantener esta restricción.
La descarga posterior evita confiar en texto del scout, pero no hace fiables las
fuentes ni elimina inyecciones de sus extractos. La barrera del Researcher sin
herramientas y el handoff limitado de SA-102 permanecen necesarios. Tests de fixtures:
`server/__tests__/researchKeyless.test.ts`; no prueban resistencia del modelo real.

## Riesgos principales

Inventario SA-102 y [mapa OWASP Agentic ASI01–ASI10](owasp-agentic.md).

## Inventario SA-102 de contenido externo (2026-10-30)

Validar la forma de un documento no acredita su contenido ni elimina instrucciones
maliciosas. Un import humano tampoco convierte texto externo en autoridad.

| Entrada y rutas reales                                                                                                                                     | Receptor actual                                                                  | Frontera y estado                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web/HTML/buscador: `server/src/researchAdapters/web.ts`, `server/src/researchHttp.ts`                                                                      | `researcher`, `read_only`, sin herramientas                                      | HTTP del runtime; SourceItems etiquetados, incluidos título y metadatos.                                                                                                                                                                                  |
| Abstracts arXiv/Semantic Scholar: `server/src/researchAdapters/papers.ts`                                                                                  | `researcher`                                                                     | Misma cuarentena; no descarga PDFs.                                                                                                                                                                                                                       |
| Libros: `server/src/researchAdapters/books.ts`                                                                                                             | `researcher`                                                                     | Solo metadatos/descripciones públicas, no obras completas.                                                                                                                                                                                                |
| Posts/comentarios: `server/src/researchAdapters/reddit.ts`                                                                                                 | `researcher`                                                                     | OAuth y red pertenecen al runtime.                                                                                                                                                                                                                        |
| Adapters registrados, cache e informes: `server/src/research.ts`, `server/src/commands/research.ts`                                                        | `researcher`; posteriormente consumidores del Brain                              | Se normaliza procedencia de caches antiguos; informe completo conserva bibliografía contaminada; salida reducida en `*.handoff.json`.                                                                                                                     |
| DAG YAML, FeatureSpec y declaraciones SQLite: `server/src/commands/task.ts`, `server/src/taskDag.ts`, `server/src/workstore/SqliteWorkStore.ts`            | Developer/QA author (`branch_write`), Reviewer/QA (`read_only` con herramientas) | `task import --origin external` etiqueta cada descripción antes de persistir la declaración; el guard rechaza el task record y el DAG etiquetados. Import local del Architect conservado. Origen declarado por el operador, no detectado automáticamente. |
| ClickUp/issues: `server/src/boardWatcher.ts`, `server/src/agentRoles.ts`                                                                                   | Oficina muestra espejo `docs/backlog/board.json`; briefs reconocen IDs ClickUp   | No se encontró importador nativo de cuerpos de issues GitHub/ClickUp a prompts. Copias manuales entran por DAG/request/brief. El espejo no concede autoridad.                                                                                             |
| Documentos `--request`/`--answers`: `server/src/commands/feature.ts`, `server/src/requirements.ts`, `server/src/architect.ts`                              | Requirements analyst/Architect (`brain_write`, herramientas de lectura)          | Briefs propios del operador (incluidos `docs/examples/*-request.md`) son peticiones humanas, sin etiqueta externa. Copias externas deben conservar el envelope JSON; texto plano sin procedencia sigue **abierto**.                                       |
| `worker --brief`, evals y task records: `server/src/worker.ts`, `server/src/evalTasks.ts`                                                                  | Rol asignado, normalmente Developer                                              | El guard protege envelopes etiquetados, no descubre procedencia de texto plano. **Abierto**.                                                                                                                                                              |
| Brain, código, diffs, resultados: `server/src/worker.ts`, `server/src/architect.ts`, `server/src/reviewer.ts`, `server/src/qa.ts`                          | Architect, Developer, Reviewer, QA                                               | SourceItems/envelopes conservados en taskData se rechazan; copiar solo texto o leerlo por herramientas pierde la etiqueta. **Abierto**.                                                                                                                   |
| Capturas PNG y texto visible: `server/src/designCaptureHost.ts`, `server/src/commands/design.ts`, `server/src/designer.ts`, `server/src/designPipeline.ts` | Product designer (`read_only`, con Read/Glob/Grep); findings al rework           | PNG generado por runtime sobre la UI propia y fixtures propios; no es una importación externa. OCR/texto externo visible no queda cubierto; sigue pendiente su cuarentena si se introduce.                                                                |

### Clasificación de origen (fase B)

«Externo» describe la fuente del contenido, no la ubicación del archivo ni quién
ejecuta el comando. Cuerpos de tareas/issues de ClickUp/GitHub, texto pegado de un
issue, respuestas obtenidas de una URL y documentos de terceros son externos,
aunque el operador los guarde o importe desde el repositorio. Una URL citada por
el operador como referencia no convierte por sí sola su petición en externa;
el contenido recuperado de esa URL sí lo es. No hay detección semántica de copias.

`task import <dag.yaml> --origin external` declara ese origen para el lote entero.
El runtime envuelve cada descripción como JSON con
`provenance: untrusted-external`, `origin: task-import` y `text`, antes de crear
las declaraciones inmutables de SQLite. La etiqueta protege también el título y
el resto de la tarea al bloquear el objeto completo. La reimportación idéntica
es idempotente; reimportar sin la opción no elimina la etiqueta: entra en
conflicto con la declaración inmutable. Un diseño ya registrado tampoco puede
reemplazarse por un import con otra declaración. No se migran tareas antiguas.

**Salida segura (hoy, manual):** una tarea importada como externa no puede
desarrollarse: es el comportamiento buscado (fail closed). Para trabajarla, el
operador la reescribe con sus propias palabras en un brief o DAG local con otra
key (`--origin local`) y cancela la externa; el texto externo nunca se copia tal
cual. Pendiente (SA-102 fase C): un lector en cuarentena que convierta la tarea
externa en una especificación estructurada y validada, revisada por el humano,
como hace `researchHandoff` con las fuentes de Research.

Sin opción (o con `--origin local`), el contrato sigue siendo el DAG local del
Architect o una tarea escrita por el operador; no se añade contaminación externa.
El operador debe declarar `external` al importar copias de sistemas externos.
Este contrato explícito no autentica al operador ni evita una declaración falsa.

Los briefs propios del operador (`docs/examples/*-request.md`, `feature run
--request`) expresan requisitos humanos y no se etiquetan como externos. Para
texto externo pegado en un brief o documento Brain, conservar el envelope de
`externalText` como JSON completo o bloque Markdown `json` al principio de línea:

```json
{ "kind": "untrusted-external-text", "origin": "issue", "text": "texto copiado del issue" }
```

El guard existente reconoce ese envelope dentro del brief/Brain al compilar y
deniega roles con herramientas. Un documento Brain propio del operador no se
etiqueta globalmente por estar en Brain. Copias antiguas sin etiqueta, texto
plano, front matter YAML y lecturas posteriores por herramientas no permiten
recuperar procedencia; siguen siendo huecos, no entradas automáticamente saneadas.

Las capturas del diseñador se generan por `captureInHost` desde la SPA compilada
del árbol de tarea, con fixtures del runtime, sin watchers ni WorkStore de
producción. Su origen es la UI propia, no una web o imagen de terceros: no se
añade etiqueta externa al PNG. Esto no acredita la seguridad semántica de sus
píxeles ni del código del árbol. Texto OCR o contenido externo que se muestre en
una captura queda fuera de esta clasificación y de la cobertura del guard JSON;
si se introduce, necesita conservar procedencia y una frontera propia.

### Barrera implementada y límites

`server/src/externalContent.ts` define `UntrustedExternalText` serializable con
origen explícito. `SourceItem.provenance = untrusted-external` etiqueta el objeto
entero. Es opcional en el contrato para leer informes antiguos; `validateSourceItem`
lo devuelve siempre etiquetado. Todos los adapters pasan por `makeSource`.
La etiqueta sobrevive a persistencia, JSON y structuredClone.

`server/src/agentCompiler.ts` inspecciona task, repository y brainContents, incluidos
anidados, JSON serializado y etiquetas dentro de Markdown. Rechaza contenido
externo para todos los roles con herramientas, también read_only y perfiles
reducidos. Solo researcher con read_only y esquema de salida puede recibirlo.
Claude recibe herramientas vacías, sin shell, red, MCP ni delegación; Codex no
admite ese rol porque su shell no cumple la frontera. Ambos Executors compilan
antes de lanzar el proceso. No es confinamiento de SO.

`researchHandoff` revalida ResearchReport, SourceItems y referencias antes de
proyectar como máximo 12 hechos de 240 caracteres, confianza enumerada y bandera
de evidencia insuficiente. No transfiere bibliografía, extractos, citas, títulos,
URLs, razones ni campos adicionales del modelo. `research run` conserva evidencia
original y escribe además `<id>.handoff.json`. El compilador revalida envelopes de
handoff, rechazando campos desconocidos y límites excedidos. Estos límites reducen
el canal copiado: **240 caracteres todavía pueden contener una inyección**. Los
hechos siguen siendo datos y requieren las políticas de acciones existentes.

Esta barrera no descubre procedencia de texto plano ni evita lecturas posteriores
del repositorio. No se añadió un lanzamiento implícito de modelo al worker: exige
integrar admisión, cuota, cancelación, auditoría y transporte de imágenes. SA-102
sigue **parcial** hasta migrar las rutas abiertas. El import declarado externo se
bloquea; briefs del operador e imports locales conservan su comportamiento.
No presentar el pipeline completo como
protegido por dual-LLM.

Pruebas: `server/__tests__/taskCli.test.ts` (import externo persistido → rechazo
en compileAgent, idempotencia y DAG local), `server/__tests__/agentCompiler.test.ts`
(briefs propios del operador), `server/__tests__/externalContent.test.ts`,
`server/__tests__/research.test.ts`, `server/__tests__/injectionBattery.test.ts` y
fixtures `server/__tests__/fixtures/injection/external-{web,paper,issue}.json`.
Comprueban procedencia, herramientas, rechazo del compilador y ausencia del payload
de los campos eliminados en el handoff. No acreditan resistencia de un modelo real
ni seguridad semántica de sus resúmenes.

### 1. Contenido no confiable

- **Descripción:** repo, web, Tasks y FeatureSpecs son datos, nunca instrucciones
  con autoridad. Pueden contener prompt injection para inducir lecturas, ejecución,
  exfiltración o cambios de permisos. Una petición incrustada no equivale a una
  instrucción del Operator ni a una Human Decision.
- **Mitigación (SA-062, SA-063, SA-064, SA-019):** contención del agente, guardias de
  rutas protegidas antes del push, batería de prompt injection y motor de políticas
  fuera del LLM. **Aceptación temporal (SA-067):** política de tratar esas fuentes como datos,
  validar acciones fuera del LLM y someter los cambios a revisión humana. Se acepta
  el riesgo residual de que el modelo siga contenido malicioso; esta política
  documental no es una barrera técnica ni autoriza ejecutar código no confiable.
- **SA-062 (contención del agente):** el push, las PRs, `git config` y `git remote`
  son del runtime, nunca del agente, en cualquier nivel de autonomía. Claude: el
  `--settings` privado del runtime registra un hook PreToolUse obligatorio
  (`dist/hooks/containment-hook.js`, sin consentimiento porque no toca
  `~/.claude`) que deniega `git push`/`send-pack`/`http-push`, `git config`,
  `git remote` y `gh`, y cualquier escritura en `.git/**`, `.claude/**`,
  `.gitconfig` o fuera del worktree (con realpath); falla cerrado (exit 2) si no
  puede leer su contexto o su entrada, y el Executor no lanza Claude sin el
  script. Si una herramienta denegada vuelve sin error (hook caído, timeout,
  hooks deshabilitados por política gestionada), el Executor detiene y falla la
  Execution. Si el stream termina sin `tool_result` para un intento contenido,
  el Executor audita cada intento pendiente y falla la Execution, incluso con
  exit 0 del CLI. Codex no tiene hooks: lo impiden `workspace-write` (red desactivada,
  fijada con `sandbox_workspace_write.network_access=false`, y `.git` fuera de
  las raíces escribibles) y `--ignore-user-config`; un intento visible en el
  stream detiene y falla la Execution. Cada denegación queda en el audit log
  (`agent_containment`, decisión de `policy.ts`, solo el hash de la entrada).
  **SA-QA-12:** Codex 0.160.0 instalado, comprobado con `codex exec --help` y
  configuración temporal aislada con `--strict-config`, no permite restar
  `.claude/` mediante `sandbox_workspace_write.*`: solo admite `writable_roots`
  (raíces adicionales, no exclusiones), `network_access`, `exclude_tmpdir_env_var`
  y `exclude_slash_tmp`. Rechaza `read_only_paths` y `read_only_subpaths` como
  campos desconocidos; coincide con la [referencia oficial de configuración](https://developers.openai.com/codex/config-reference).
  Por ello los adaptadores detectan escrituras evidentes por shell sobre rutas
  protegidas: redirecciones, `Set-Content`/`Out-File`/`Add-Content`, `tee`,
  `cp`/`mv`/`copy`/`move` (también `Copy-Item`/`Move-Item`) y escrituras inline de
  Node/Python con rutas literales. Los `file_change` protegidos también deniegan;
  Codex audita el intento como `agent_containment`, detiene y falla la Execution.
  Git con subcomando dinámico (`$`, backticks, `%VAR%`, sustituciones) o
  `-c alias.*` se deniega. Con contexto legible, el hook audita stdin inválido
  como `unparseable` antes de salir con código 2.
  **Límite residual:** es una guardia conservadora, no un parser de shell ni un
  sandbox. Puede denegar una copia desde una ruta protegida o una ruta citada
  en un script que también escribe. Rutas calculadas, escrituras desde scripts
  indirectos, `eval` y alias Git heredados pueden eludir la detección. El stream
  de Codex se observa después de iniciar la herramienta: detener y fallar el run
  no garantiza evitar ni revertir una escritura ya ejecutada en `.claude/`.
  El pushurl neutralizado (SA-032), la guardia antes del push (SA-063) y la red
  desactivada siguen aportando defensa en profundidad; el aislamiento de SO
  de SA-058 queda pendiente. No ejecutar contenido adversarial bajo la hipótesis
  de que esta guardia confina todos sus efectos.
- **Revisit when:** antes de procesar repos externos o contenido adversarial, o
  ampliar herramientas/autonomía; evaluar aislamiento mediante SA-058.

### 2. Configuración heredada de los CLIs

- **Descripción:** los Executors heredan configuración, autenticación y capacidades
  del usuario. Claude puede heredar MCPs con escritura en ClickUp, Windows-MCP,
  computer-use y permisos `allow` de `~/.claude/settings.json`; Codex, MCPs de
  `~/.codex/config.toml`. Un worktree no limita esas capacidades.
- **Evidencia local (solo lectura):** el settings de Claude contiene categorías de
  MCP de conocimiento y Unity, y omisión global de permisos activada; no contiene
  `permissions.allow`. La configuración Codex declara categorías de ejecución
  Node, MCP mediante Docker, Unity y conocimiento. ClickUp con escritura,
  Windows-MCP y computer-use son capacidades a comprobar en el entorno efectivo,
  no entradas confirmadas en ese settings de Claude. No se reproducen valores,
  comandos, endpoints ni credenciales.
- **Mitigación (SA-020, SA-033, SA-034, SA-062, SA-074):** compilar AgentSpec a flags
  con aislamiento de la configuración del usuario, Executors aislados, contención
  del agente y cierre de WebSearch/WebFetch en los perfiles del slice. SA-074 lo
  aplica en ambos CLIs, incluido `web_search="disabled"` en Codex (activo por
  defecto), con tripwire en los Executors: [web-access.md](web-access.md).
  **SA-QA-4:** `--ignore-user-config` no quitaba los conectores de la cuenta
  ChatGPT (`codex_apps`: Gmail, ClickUp, Sites, llamadas, acceso a internet).
  Ahora se apagan con `features.apps=false` y afines, y cualquier llamada MCP
  hace fallar la Execution. Codex 0.160.0 también ofrece delegar en
  sub-agentes, y ningún flag lo impide: el Executor falla la ejecución si ve
  un `collab_tool_call` o un rollout hijo. Además, `project_doc_max_bytes=0`
  deja de inyectar el AGENTS.md del repo, y `AGENTS.md`, `CLAUDE.md`,
  `.codex/`, `.agents/` y `.mcp.json` son rutas protegidas.
  **Aceptación temporal (SA-067):** se acepta temporalmente la herencia para
  trabajo local supervisado; inventariar capacidades efectivas antes de lanzar
  una Execution. El aislamiento de configuración exigido por ADR-0002 sigue
  pendiente; un perfil declarado en el Project Brain no recorta permisos reales.
- **Revisit when:** cambie la configuración del Operator, se añada un MCP con
  escritura/control del host o se habiliten lanzamientos autónomos desde el runtime.

### 3. Workflows de PR con secrets

- **Descripción:** una PR desde una rama del mismo repo puede ejecutar su propia
  versión de workflows y código con acceso a secrets; puede modificar las guardias
  para exfiltrarlos antes del merge.
- **Evidencia tras SA-066:** [ci.yml](../../.github/workflows/ci.yml) se dispara por
  `pull_request` hacia `main` (opened, synchronize, reopened, labeled, unlabeled)
  y `push` a `main`, con exclusiones de rutas Markdown, LICENSE y FUNDING.
  No usa `pull_request_target`. El precheck del preview exige `pull_request` y
  `github.repository == 'pixel-agents-hq/pixel-agents'`; descarta PRs de forks y
  exige `VERCEL_TOKEN`, `VERCEL_ORG_ID` y `VERCEL_PROJECT_ID`. El deploy recibe esos
  secrets y usa `GITHUB_TOKEN` para comentar, con permisos de escritura en issues
  y PRs. Hoy ese preview no se ejecuta en `fedeggarrido/SoftwareAgents`; sí existe
  la superficie si una rama modifica las condiciones y hay secrets disponibles.
  El precheck usa `always()` y no comprueba los resultados CI/E2E, aunque los recibe.
- **Mitigación (SA-066, SA-007):** guardias de repo, ruleset de `main`, ajustes de
  cuenta y merge humano. **Aceptación temporal (SA-067):** las guardias
  actuales reducen el alcance del preview, pero no protegen frente a una rama del
  mismo repo que las cambie. Se acepta el residual en el flujo supervisado: revisar
  workflows y código ejecutado con secretos antes de abrir/actualizar una PR.
- **Revisit when:** antes de habilitar preview/secrets en el fork, cambiar eventos,
  permisos o workflows, o permitir a agentes abrir/actualizar PRs automáticamente.

### 4. `project.yaml` no concede autoridad

- **Descripción:** es editable por Agents; sus declaraciones pueden intentar
  ampliar permisos, comandos o alcance del Project.
- **Mitigación (SA-009, SA-019):** limitar `project.yaml` a identidad y rutas, con
  autoridad en Operator config y motor de políticas fuera del LLM.
  **Aceptación temporal (SA-067):** tratarlo como datos del Project Brain y
  exigir autoridad externa en Operator config. `companyControl` ya autoriza argv
  desde `companyAutopilot` en `~/.pixel-agents/config.json`, no desde `board.json`;
  `pathGuard.resolveInside` comprueba contención con realpath. Eso no constituye
  validación de `project.yaml` ni confinamiento del proceso hijo.
- **Revisit when:** se conecte `project.yaml` al lanzamiento de Executors o cambien
  las fuentes de permisos y comandos.

### 5. Token del servidor en la URL

- **SA-095 (telemetría):** OTLP/HTTP está desactivado por defecto y solo lo habilita
  Operator config. Activado, salen al collector elegido IDs de traza/Execution/Task,
  proveedor/modelos, rol/nivel/esfuerzo, nombres de herramienta, contadores, tiempos
  y estados; nunca prompts, salidas, argumentos/resultados, rutas de usuario ni
  token del servidor. Sin opt-in de contenido. Véase [execution-telemetry.md](../execution-telemetry.md).

- **Descripción:** el CLI imprime `?token=` y la SPA lo transmite al WebSocket.
  Es una capacidad bearer reutilizable que puede quedar en historial, terminal y
  logs de versiones anteriores a SA-075; quien la obtenga puede enviar mensajes privilegiados.
- **Mitigación (SA-075):** Fastify redacta el query token en HTTP y upgrades WS,
  omite Authorization del serializador y redacta cabeceras explícitas. Se elimina
  el log de tipos WS arbitrarios; AuditLog redacta credenciales. Cada servidor
  nuevo genera un UUID. `pixel-agents token rotate [--port PORT]` exige Bearer,
  rechaza Origin, audita sin secretos, revoca el anterior y desconecta sockets.
  Discovery se republica con escritura restringida y reintentos ante fallos.
  Véase [discovery](../reference/discovery.md) y [ADR-0005](../adr/0005-server-token-transport.md).
- **Aceptación temporal (SA-067):** aceptación explícita del transporte actual
  en uso local supervisado; tratar la URL como secreto y no compartirla. El bind
  por defecto a loopback y la comprobación del token existen, pero no evitan fugas
  ni convierten la posición de red en autorización.
- **Revisit when:** antes de exposición remota, compartir logs/URLs, o tras una fuga;
  reevaluar transporte, redacción de logs y renovación del token.

### 6. Sin sandbox de SO para Claude en Windows

- **SA-093:** ambos Executors lanzan el CLI dentro de un Windows Job con
  KILL_ON_JOB_CLOSE y breakaway deshabilitado, antes de ejecutar código del CLI.
  El supervisor fijo espera registro duradero y asignación antes de lanzar.
  Recuperación termina el Job y espera cero procesos activos; cancelación usa
  IPC al supervisor. El helper kernel32 está embebido, sin archivos de caché ni
  entrada del modelo, no eleva permisos y solo actúa sobre esa Execution.
  Véase [workstore-leases](../workstore-leases.md). Contiene el ciclo de vida,
  no filesystem, red, procesos externos ya existentes ni autoridad del usuario.
  Un adversario con los mismos permisos del operador puede manipular procesos,
  handles o nombres de Job: esto no sustituye el sandbox SA-058. Sin Job, los
  registros históricos conservan el fallback CIM y su carrera de descendientes.

- **SA-QA-20 (evals):** el verificador ejecuta código del agente como el operador fuera del sandbox del Executor; allowlist de entorno/rutas, temporales y timeout no confinan el host ni impiden manipular Vitest desde un fichero permitido. Solo tareas propias y agentes cooperativos; véase [Límites de seguridad](../evals.md#límites-de-seguridad).

- **Descripción:** el único aislamiento de trabajo es el worktree; Claude puede
  acceder al host con los permisos efectivos del usuario. No limita filesystem,
  red, recursos ni otros proyectos. Las guardias de rutas del runtime no confinan
  los comandos o MCPs del Executor.
- **Mitigación (SA-058, SA-062):** sandbox Docker (Later) y contención del agente.
  **Aceptación temporal (SA-067):** riesgo aceptado para el MVP local supervisado,
  con worktree por Task y alcance explícito; sandbox aplazado según ADR-0002.
- **Revisit when:** se necesite ejecutar código no confiable, ampliar autonomía o
  limitar acceso al host; disparar la evaluación SA-058 antes de habilitar ese caso.

### 7. Cuota de cuenta compartida

- **Descripción:** la cuota pertenece a la cuenta y se comparte con Fundtrinsic;
  una Execution puede agotar capacidad necesaria para otro proyecto. Una
  CapacitySnapshot es observación, no reserva ni garantía.
- **Mitigación (SA-035, SA-036, SA-037, SA-038):** CapacitySnapshot, quota gate,
  ledger con topes y paralelismo ≤2, y manejo de cuota agotada.
  **Aceptación temporal (SA-067):** se acepta la competencia de cuota bajo
  supervisión; observar disponibilidad y mantener desconocido lo no medido. Los
  límites por Executor a nivel de máquina exigidos por ADR-0002 siguen pendientes;
  este registro no autoriza intervenir en Fundtrinsic.
- **Revisit when:** antes de paralelismo o ejecuciones desatendidas, o si el consumo
  de SoftwareAgents afecta a disponibilidad de otros trabajos de la cuenta.

### 8. Merge siempre humano

- **Descripción:** una propuesta de Agent o tests verdes pueden introducir cambios
  dañinos; tampoco acreditan autorización para integrar.
- **Mitigación (SA-007, SA-046):** ruleset de `main` y ajustes de cuenta; el
  orquestador no hace merge a `main`: SA-046 integra únicamente en
  `sa/<FEAT>-integration` y termina en `ready_to_merge` para revisión e integración
  humanas. **Aceptación temporal (SA-067):** mantener el Gate humano de
  [AGENTS.md](../../AGENTS.md): revisión cruzada manual, hallazgos resueltos y tests
  verdes; Claude integra tras esa revisión dentro del flujo autorizado por Fede.
  Ningún Agent ejecutado por la Platform recibe autoridad de merge autónomo.
- **Revisit when:** cambien permisos Git/CI, reglas de integración o se proponga
  automatizar el merge; requerir una Human Decision antes de cambiar este Gate.

### 9. Ingreso humano con token privilegiado (SA-107)

- **Descripción:** borrar `SA_MANAGED_EXECUTION`, `SA_AUTOPILOT`, `SA_WORKER` y
  `CLAUDECODE` ya no basta para presentar una decisión humana por CLI.
- **Mitigación:** `featureIngress.ts` exige el token vigente de discovery
  (`server.json`, instancia con PID vivo), proporcionado por el operador mediante
  `PIXEL_AGENTS_OPERATOR_TOKEN` o `--confirm` al final del comando (stdin TTY en
  modo raw, sin eco; sin TTY falla cerrado). Compara digests SHA-256 de tamaño fijo
  con `timingSafeEqual`, antes de escribir artefactos, abrir WorkStore o auditar.
  SA-QA-107 resuelve el perfil de esta comprobación con `os.userInfo().homedir`,
  sin aceptar `HOME` ni `USERPROFILE` del llamador. Después exige una prueba del
  servidor activo en `127.0.0.1`: HMAC-SHA-256 de un nonce aleatorio nuevo y su
  PID, con contexto de protocolo y el token como clave. El cliente nunca envía
  el token y falla cerrado ante errores, respuesta inválida o timeout absoluto.
  Los errores nunca incluyen el valor recibido. Los marcadores siguen denegando
  decisiones incluso con token. Executors, supervisor, autopilot, sondas y
  bootstrap eliminan explícitamente la variable después de fusionar overrides,
  también con otras mayúsculas en Windows. El filtrado cubre además git,
  verificadores, capturas, limpieza y recuperación de procesos. Los terminales
  de VS Code anulan la variable y sus variantes presentes con valores `null` en `env`.
- **Inventario CLI:** `feature run|approve|rebase`, `feature spec|design --answers`,
  `review finding --accept|--reject`, `learning approve|reject`, `task retry`,
  `design review|direction|apply-direction`, `research run` y `usage backfill`
  (salvo `--dry-run`), además de `worker run` directo y `eval run` (también con
  `--yes`). `feature spec --request`, `feature design` sin respuestas,
  `feature develop|review|qa` son etapas del runtime: no registran una aprobación
  humana. Se conservan la admisión de `feature run` por argv exacto de
  `companyAutopilot` en Operator config y la revisión acotada del pipeline de
  diseño. No admiten decisiones ni respuestas humanas implícitas.
- **Oficina y lecturas:** DecisionsPanel conserva la autorización WS privilegiada
  de §5; no usa esta confirmación CLI. `list`, `show`, `precision`, `flow`, `usage`
  y el preview de backfill no requieren token. Véase
  [confirmación del operador](../reference/discovery.md#confirmación-humana-en-cli-sa-107).
- **Límite residual:** es una capacidad bearer, no una prueba de presencia física.
  El servidor compartido del host no publica una vinculación criptográfica por
  Project; se usa el puntero predeterminado de discovery. Un agente con los mismos
  permisos del operador todavía puede leer el token en su perfil, historial o
  memoria, o modificar el código que verifica. Filtrar el entorno no protege esos
  canales ni las ACL de discovery. SA-058 (aislamiento de SO y secretos fuera del
  alcance del agente) sigue pendiente; no presentar SA-107 como confinamiento.
- **Revisit when:** se ejecute contenido adversarial, se comparta discovery entre
  identidades/Projects, cambien los ingresos o se implemente SA-058.

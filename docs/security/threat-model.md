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

## SA-146 · Creación de alojamiento GitHub

`githubHosting.ts` ejecuta una acción externa del operador mediante `gh` y `git`
con `execFile`, sin shell y con timeout. Tanto consulta como confirmación requieren
privilegio del transporte e ingress humano antes de acceder al proyecto. El destino
local procede del proyecto seleccionado por el servidor. Se validan nombre y
propietario contra la cuenta y sus organizaciones en github.com. La cuenta se
comprueba otra vez al confirmar. Un identificador efímero caduca a los cinco minutos
y se consume antes del primer await de creación. Los intentos concurrentes se
serializan por proyecto. Cada fallo exige una nueva lectura y confirmación.

El primer commit incluye únicamente el manifiesto preparado, usa la identidad Git
configurada y desactiva hooks y firma interactiva. La creación añade origin y el
envío comprueba su URL de push. Una creación correcta seguida de fallo de push
conserva el destino en memoria y permite confirmar solo ese envío. Tras reiniciar
el runtime, un origin existente requiere revisión manual en la terminal. Un timeout
de creación puede dejar un repositorio remoto creado sin respuesta local, por lo
que el mensaje pide comprobar GitHub antes de reintentar. El historial completo del
proyecto se envía al propietario y con la visibilidad mostrados al confirmar.

La UI carece de campos de token. El runtime no lee la configuración de gh ni registra
stdout/stderr, credenciales o errores crudos. La auditoría conserva proyecto y estado.
GitHub CLI mantiene su autenticación en el entorno del operador y se conecta con
`gh auth login` en su terminal. El runner de pruebas está inyectado y el e2e usa un
ejecutable gh falso en PATH, con perfiles aislados. Persisten las fronteras de
confianza de los ejecutables/configuración Git del operador y de procesos del mismo
usuario que puedan cambiar archivos o remotos durante una operación.

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

SA-109 guarda borradores mediante staging exclusivo, fsync, validación y
publicación atómica sin sobrescritura. Revalida el realpath del staging dentro
del checkout antes de publicar. Se acepta el riesgo residual de que otro proceso
del mismo usuario sustituya un directorio padre entre validación y apertura o
publicación. Node no proporciona aquí apertura relativa a un handle de directorio.
Las comprobaciones de rutas y propietarios de reservas mantienen el alcance del
almacén local supervisado. La separación frente a un adversario del mismo usuario
depende del aislamiento de SO pendiente en SA-058. Los detalles de almacenamiento
y recuperación están en el [flujo de ideas](../feature-pipeline.md#ideas-desde-la-oficina-sa-109).

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

- **SA-116.** La SPA captura el token inicial y elimina todos los parámetros
  `token` de la URL de la página mediante `history.replaceState`, antes de abrir
  el WebSocket. La URL de conexión permanece solo en memoria para los handshakes
  y reconexiones. No se persiste en cookies, localStorage ni sessionStorage, ni se
  vuelve a leer de `location` para enlaces, copias o informes. Recargar pierde el
  privilegio. SA-144 permite volver a entrar abriendo Pixel Agents desde un
  arranque humano interactivo que entrega un código efímero al navegador.
  VS Code conserva su autoridad por el canal integrado sin token en URL.
  `officeAccess` comunica únicamente el privilegio existente y los motivos
  cerrados de falta de token o proceso gestionado. Los guards del servidor siguen
  siendo la autoridad. La UI muestra esos estados sin alertas de lectura denegada
  de ideas ni formularios de entrevista o reintentos por permisos.
- **Riesgo residual de SA-116.** `replaceState` sustituye la entrada actual del
  historial. No garantiza eliminar copias previas o sincronizadas ni capturas
  anteriores al arranque de JavaScript. La navegación nueva transporta un código
  efímero y el handshake WS continúa llevando el token en query. Discovery,
  memoria de página y herramientas de red del navegador siguen exponiendo la
  capacidad a quien tenga acceso. La redacción de logs de SA-075 permanece. La
  retirada de la barra no revoca el bearer ni resuelve el riesgo de mismo usuario
  del SO. Revisar al cambiar el transporte o implementar SA-058.

- **SA-144.** Standalone conserva un token por usuario en
  `~/.pixel-agents/office-access.json`, junto al puerto predeterminado para
  reconectar tras reiniciar. Creación y rotación usan el lock de discovery,
  temporales exclusivos, fsync y rename. El archivo usa 0600 en POSIX. Windows
  aplica una ACL de acceso completo únicamente para el SID del usuario, sin
  herencia, antes de escribir el secreto. Get-Acl verifica una única regla
  explícita Allow FullControl para ese SID y DACL protegida. Cualquier fallo
  de identidad, aplicación o verificación abandona la persistencia y genera
  un token en memoria por ejecución; Settings avisa de que no sobrevivirá al
  reinicio. Las copias standalone de discovery también exigen protección
  verificada antes de escribir; si no se consigue, no se publican.
  El CLI nunca imprime el token persistente. El lanzador recibe un código
  aleatorio de 32 bytes, de un solo uso y con TTL de 60 segundos centralizado
  en constantes. La SPA lo retira de la URL antes de intercambiarlo por el token.
  Emisión exige Bearer y proceso humano sin Origin. Emisión e intercambio exigen
  peer y Host loopback y rechazan Origin ajeno, con límite común de 20 intentos
  por minuto por proceso, incluidos fallos. Respuestas no-store y redacción de
  códigos en logs; solo memoria, sin reintentos de intercambio. Rotar invalida
  códigos pendientes. Solo se guardan digests SHA-256 de los códigos y el
  intercambio compara todas las entradas con timingSafeEqual, sin búsqueda por
  el secreto. El arranque humano interactivo sin auto-open imprime un enlace
  efímero y «Si caduca: pixel-agents open». El comando open autentica el registro
  local mediante prueba HMAC antes de enviar Bearer a loopback y abre o imprime
  otro enlace de un solo uso; rechaza los marcadores gestionados existentes.
  Los arranques sin TTY o gestionados no imprimen enlaces de acceso.
  Auto-open exige stdin y stdout TTY, sin marcadores gestionados, CI, VITEST,
  PLAYWRIGHT, NODE_ENV=test, PIXEL_AGENTS_NO_OPEN ni `--no-open`.
- **Riesgo residual aceptado de SA-144.** Reiniciar deja de revocar un token
  robado. Todas las instancias standalone del usuario comparten la capacidad
  hasta `pixel-agents token --rotate` o la revocación desde Settings. Se audita
  sin secretos y no se devuelve la nueva capacidad al cliente. La rotación WS
  exige conexión privilegiada y proceso humano, conservando los marcadores
  gestionados. Cada instancia revalida antes de mensajes y peticiones, y cierra
  sockets inactivos al detectar el cambio mediante un sondeo de un segundo.
  Se mantienen los gates de conexión y el bind loopback predeterminado.
  La capacidad puede leerse en el perfil, discovery, memoria y herramientas del
  navegador. El código efímero puede verse en argumentos del lanzador o capturas
  de la navegación inicial o en la terminal cuando el operador pide el enlace:
  un proceso que lo robe y lo canjee dentro del plazo,
  antes que la página, obtiene la capacidad. Un proceso del mismo
  usuario puede suplantar el listener del puerto guardado para recibir el
  token que una pestaña envía al reintentar. El handshake no autentica al servidor.
  La separación frente a ese adversario sigue dependiendo de SA-058.
  Los cambios no conceden privilegio
  a una pestaña que carece de capacidad ni permiten lanzar trabajo de agentes.
  La copia explícita del token para la confirmación CLI vive solo en Settings →
  Detalles; añade el portapapeles como canal elegido por el operador. No se muestra
  ni se incluye en comandos, URLs de navegación nuevas ni logs. Un borrador de idea
  conserva su proyecto de origen y bloquea guardar tras reconectar a otro proyecto,
  manteniendo texto y respuestas para copiar o descartar.

- **SA-111.** `approveFeaturePlan` usa exclusivamente el privilegio decidido por
  el handshake WS de esta sección. Antes de resolver el Project rechaza conexiones
  sin privilegio y servidores con marcadores gestionados. El servidor fija `human`
  al invocar `approveFeature`; campos cliente como `actor` o `privileged` son
  inválidos. El adapter VS Code y su WS embedded rechazan este control.
  `requestFeaturePlan` y el listado `requestFeatures` también exigen conexión
  privilegiada antes de acceder al Project. Sin privilegio responden `denied`, con
  plan nulo o listado vacío. La UI muestra el mensaje de solo lectura. La lectura
  privilegiada queda limitada al Project vinculado e incluye sus artefactos del plan.
  El contenido se renderiza como texto escapado, sin HTML, Markdown activo,
  navegación, herramientas ni ejecución. El contenido del plan nunca se registra
  en logs o auditoría.

  SA-128 añade una proyección legible del mismo contenido permitido. Reutiliza
  los validadores de esquema y el análisis del DAG en el servidor, proyecta campos
  explícitos y resuelve dependencias por título. Estos validadores comprueban la
  estructura. Los textos conservan su carácter de datos no confiables y se
  renderizan escapados, incluidos resumen, títulos, riesgos y documentos plegados.
  El pie separa estado operativo y causa de bloqueo de ingreso. Un proceso
  gestionado sigue sin poder aprobar aunque la conexión tenga privilegios.
  El estado final usa WorkStore y la evidencia Git existente. La vista conserva
  el documento original, incluido su estado declarativo histórico.

- **SA-095 (telemetría):** OTLP/HTTP está desactivado por defecto y solo lo habilita
  Operator config. Activado, salen al collector elegido IDs de traza/Execution/Task,
  proveedor/modelos, rol/nivel/esfuerzo, nombres de herramienta, contadores, tiempos
  y estados; nunca prompts, salidas, argumentos/resultados, rutas de usuario ni
  token del servidor. Sin opt-in de contenido. Véase [execution-telemetry.md](../execution-telemetry.md).

- **Descripción:** la navegación inicial y el handshake WS transportan `?token=`.
  Es una capacidad bearer reutilizable que puede quedar en historial y memoria,
  en terminales de versiones anteriores a SA-144 y en logs anteriores a SA-075.
  Quien la obtenga puede enviar mensajes privilegiados.
- **Mitigación (SA-075):** Fastify redacta el query token en HTTP y upgrades WS,
  omite Authorization del serializador y redacta cabeceras explícitas. Se elimina
  el log de tipos WS arbitrarios; AuditLog redacta credenciales. Cada servidor
  embedded nuevo genera un UUID. Standalone conserva el token de SA-144.
  `pixel-agents token rotate [--port PORT]` exige Bearer,
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

- **SA-113.** `research review <FEAT-ID>` comparte el ingreso humano y la
  confirmación de coste de `research run`; no hay lanzamiento automático ni desde
  oficina. Solo lee una Feature con run construida `ready_to_merge`, rama y SHA
  vinculados, y valida sus promesas mediante `featureDocument`, sin relajar esa
  barrera. El diff se fija a la base histórica y el SHA construido; Git desactiva
  diff drivers externos, textconv y escrituras opcionales del índice. FeatureSpec,
  diseño, DAG, informe previo y diff entran como datos no confiables en el envelope
  existente. El investigador Claude conserva herramientas vacías, sin red, shell,
  MCP o delegación. No se propagan instrucciones del diff o las fuentes al sistema.
  Reutiliza el control de presupuesto SA-112, incluido plazo global, margen de coste,
  coste desconocido conservador y un único reintento de validación con saldo.
  Los cortes y fallos conservan cobertura parcial: toda fila sin cita comprobable
  pasa a `not verifiable`, y las fuentes previas solas no prueban entrega.
  Las citas se cotejan con líneas del lado nuevo del diff o extractos revalidados;
  solo líneas añadidas en archivos de implementación/tests JS/TS con sintaxis
  válida pueden aportar procedencia del código citado. El parser de TypeScript identifica
  tokens de declaraciones con implementación, llamadas, asignaciones, retornos y
  lanzamientos de error; la cita debe abarcar uno. Se excluyen `docs/`,
  `.softwareagents/`, documentos del plan y declaraciones de tipos. Comentarios,
  strings aislados, texto de plantillas/JSX, títulos de tests y contexto sin cambios
  no aportan tokens de código. Se excluyen además declaraciones que solo contienen
  strings, wrappers de tests vacíos o pendientes y funciones vacías.
  La lista positiva de extensiones rechaza también
  README sin extensión y `.markdown`; renombrar prosa a código no evita el análisis
  sintáctico del archivo nuevo completo. Git entrega nombres delimitados por NUL
  (`--name-only -z`); cada patch se vincula a su ruta literal sin interpretar
  espacios, tabs ni escapes de sus encabezados. Los renombrados se
  descomponen en borrado/alta. Otras extensiones y sintaxis sin reconocer se degradan
  a `not verifiable`. El estado `code_cited` se muestra como «Código citado: requiere
  verificación»: es un puntero para revisión humana, no una prueba de entrega.
  Límite conocido: código con sintaxis válida puede ser irrelevante o ineficaz;
  las heurísticas de texto no prueban pertinencia, comportamiento correcto ni
  cumplimiento de criterios. Las propuestas no
  crean Tasks ni cambian decisiones. El WorkStore se abre en solo lectura, sin
  migraciones, recuperación ni escrituras de estado. Solo se publican informes
  Markdown/JSON con UUID en `softwareagents/feature-research/<Project>/<FEAT>/`
  del Git common dir, fuera del árbol de las ramas; no se alteran exclusiones Git.
  El texto se representa literalmente y queda fuera de logs, CLI JSON y auditoría.
  Se mantienen los riesgos de acceso del mismo usuario, carreras de rutas y falta
  de sandbox de SO; los fixtures no acreditan resistencia de un modelo real.

- **SA-112.** `research run` mantiene exclusivamente el ingreso CLI de SA-107,
  con rechazo de marcadores gestionados. Antes de recopilar o persistir exige además
  `--accept-cost` con estimación y tope exactos mostrados al operador. Los límites
  proceden de Operator config por Project, validados contra techos de runtime.
  Pregunta, idea, resultados del scout, páginas e informe son datos sin autoridad
  para modificar límites, permisos o etapas. El scout sigue limitado a seis turnos
  y recibe únicamente la pregunta pública explícita. El borrador llega a síntesis
  dentro del envelope no confiable.
  El plazo global interrumpe también adapters e iteradores que ignoran la señal.
  Los cortes y fallos conservan un informe parcial. El consumo de tokens es una
  observación posterior. Antes de cada síntesis o reintento, `researchBudget`
  estima ceil(bytes ASCII / 2 + bytes no ASCII) del sistema compilado (esquema incluido)
  y contexto, más 1.024 tokens de framing, y comprueba tamaño, tokens restantes y
  coste de entrada antes de llamar al Executor. El rechazo indica usar `deep` o
  reducir la entrada. No llama a una API para contar tokens. La estimación cubre el
  input escrito por el runtime, no mide el contexto que pueda añadir el proveedor;
  el framing es una reserva fija. Sin tokenizer exacto puede subestimar el consumo:
  la cancelación por uso de tokens reportado en runtime sigue siendo la guarda final.
  Los fixtures BPE independientes son adversarios locales, no medidas
  del tokenizer de Claude. El tope es una estimación a precios API: una sola respuesta
  puede superarlo ligeramente, como advierten la confirmación y el informe en español.
  Antes de cada llamada de scout, síntesis o reintento se resta del presupuesto
  restante un margen fijo del 20% del tope total y se transmite la asignación positiva
  como `--max-budget-usd`. El CLI comprueba el presupuesto después de la respuesta;
  el margen mitiga el sobrepaso sin garantizar un máximo estricto. Cada llamada suma
  el coste declarado por el CLI; si falta o es inválido, suma toda su asignación.
  Al alcanzar el tope o quedarse sin margen no se inicia otra llamada y el informe
  parcial registra gasto y motivo, conservando cualquier sobrepaso y evidencia validada.
  `--discover` permite scout, recopilación y síntesis dentro de estos límites.
  El informe hermano de la idea conserva procedencia externa y hash del borrador.
  La lectura del plan revalida fuentes y extrae el handoff acotado existente dentro
  de `untrusted-context-data`, separado de `request` y `answers`. Los informes se
  rechazan como entrada humana. Un lock exclusivo serializa publicación y gasto
  por idea, y el JSON autoritativo se publica atómicamente. Un crash deja el lock
  para inspección. Ninguna lectura lanza etapas. Logs, `--json` y auditoría omiten
  texto externo y el contenido del informe.
  Los importes son estimaciones a precios API, con supuestos fijados en constantes.
  La semántica de sobrepaso del CLI figura en la documentación de Claude Code.
  [Claude Code](https://code.claude.com/docs/en/agent-sdk/agent-loop#budget-headroom).

- **SA-111.** La aprobación en oficina conserva el WS privilegiado de §5 y el
  servicio CLI compartido. No requiere la confirmación TTY del CLI. La presencia
  de `SA_MANAGED_EXECUTION`, `SA_AUTOPILOT`, `SA_WORKER` o `CLAUDECODE` en el
  proceso servidor, incluso con valor vacío, deshabilita y rechaza la aprobación.
  Son marcadores del servidor, no pruebas de identidad del cliente. No se aceptan
  marcadores ni actores enviados por el cliente. Un Agent sin privilegio no puede
  aprobar. La capacidad bearer robada por un proceso sin marcadores conserva el
  riesgo residual de mismo usuario descrito abajo y exige la separación de SA-058.
  La revisión enviada es SHA-256 del key, SHA del spec y fuentes completas del
  FeatureSpec, TechnicalDesign y DAG mostrados. Se comprueba de nuevo bajo la
  transacción de aprobación y la barrera Git de `featureDocument`. Una revisión
  obsoleta requiere refresco y otro clic humano. El WorkStore serializa los
  reenvíos y revalida sus barreras. CLI calcula la revisión con la misma proyección
  que WS. `approved_plan_revision`, nullable en bases migradas, se escribe en la
  transacción de aprobación. El plan solo figura aprobado si su revisión coincide
  con esa vinculación y el estado de Feature es `approved` o `ready_to_merge`.
  Una FeatureSpec ya aprobada con otra revisión o vinculación nula permite al humano
  aprobar el plan actual. Esa operación solo cambia la vinculación. El gate de
  Developer sigue dependiendo exclusivamente del estado de Feature. El pipeline
  conserva sus gates existentes.
  CLI y oficina registran un par ordenado `pending`/`approved` por nueva vinculación,
  con política, actor, SHA y revisión, sin contenido. `pending` precede al commit
  SQLite y `approved` lo confirma. Los reenvíos de una revisión coincidente, incluso
  tras `ready_to_merge`, no añaden entradas. Si falla la intención se deniega y los
  rechazos del servicio conservan su auditoría.
  **Riesgo residual aceptado.** JSONL y SQLite no comparten transacción. Un fallo del
  commit puede dejar una intención sin aprobación. Si falla la confirmación después
  del commit, la aprobación y su vinculación persisten, el servidor emite un aviso
  fijo sin contenido, WS devuelve éxito y CLI comunica el fallo de confirmación.
  No hay recuperación y un reenvío exitoso no repone la confirmación perdida. El
  historial puede conservar únicamente `pending` para una aprobación comprometida.
  Revisar esta aceptación si se exige reconstrucción completa desde JSONL.
  No se lanza ninguna etapa al leer o aprobar.

- **Descripción:** borrar `SA_MANAGED_EXECUTION`, `SA_AUTOPILOT`, `SA_WORKER` y
  `CLAUDECODE` ya no basta para presentar una decisión humana por CLI.
- **Mitigación:** `featureIngress.ts` exige el token vigente de discovery
  (`server.json`, instancia con PID vivo), proporcionado por el operador mediante
  `PIXEL_AGENTS_OPERATOR_TOKEN` o `--confirm` al final del comando (stdin TTY en
  modo raw, sin eco; sin TTY falla cerrado). Compara digests SHA-256 de tamaño fijo
  con `timingSafeEqual`, antes de escribir artefactos, abrir WorkStore o auditar.
  SA-QA-107 usa `discoveryRoot()` con `os.homedir()`, igual que el resto de
  discovery, respetando `HOME` o `USERPROFILE` según el SO. Después exige una prueba del
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
  `design review|direction|apply-direction`, `research run|review` y `usage backfill`
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
  Project. Se usa el puntero predeterminado de discovery. Un agente que se ejecute
  con el mismo usuario del SO puede borrar los marcadores gestionados, falsificar
  discovery y levantar su propio servidor de prueba para superar la confirmación.
  También puede leer el token en el perfil, historial o memoria del operador, o
  modificar el código que verifica. Los marcadores, la contención del Executor,
  `protectedPaths` y el filtrado del entorno mitigan este riesgo residual. La
  separación efectiva requiere una identidad de SO distinta y secretos fuera del
  alcance del agente, pendiente en SA-058.
- **Revisit when:** se ejecute contenido adversarial, se comparta discovery entre
  identidades/Projects, cambien los ingresos o se implemente SA-058.

## Preparación humana del Project (SA-114)

La creación de `.softwareagents/project.yaml` y `.softwareagents/brain` usa un
servicio común para CLI y oficina. WS exige la conexión privilegiada existente
antes de descubrir rutas. CLI confirma la creación y valida el token del servidor
activo mediante SA-107, incluso con `--yes`. La presencia de cualquier marcador
`SA_MANAGED_EXECUTION`, `SA_AUTOPILOT`, `SA_WORKER` o `CLAUDECODE`, incluido un valor
vacío, deniega la creación. El servidor determina la raíz Git y acepta únicamente
el nombre como dato del formulario. VS Code responde `unsupported_adapter`.

El manifiesto describe identidad, remoto, rama y ruta del Brain. La autoridad
procede de Operator config. El id incluye un hash de la raíz canónica y se rechaza
si ya existe una configuración del operador para esa identidad. La preparación
queda así separada de concesiones anteriores. Un nombre acotado y sin controles
se serializa con la biblioteca YAML. El remoto se limita a HTTP(S), SSH o Git,
con userinfo, query y fragment eliminados antes de preview, escritura o salida.
La sintaxis SCP se convierte a URL SSH saneada. Un repositorio sin remoto usa
`local`. Los formatos restantes requieren revisión humana.

Las rutas fijas pasan por `taskPath`, que valida contención y rechaza enlaces y
junctions en los componentes descendientes, incluidos enlaces escapando la raíz.
Toda entrada previa en la ruta del manifiesto, válida, inválida o colgante, causa
rechazo. La publicación enlaza atómicamente un archivo temporal exclusivo, tras
fsync, a un destino inexistente. La limpieza comprueba identidad y retira solo
temporales propios. Los directorios se conservan tras un fallo de E/S, para
permitir reintentos y proteger una preparación concurrente. Git se consulta con comandos
de lectura. El humano hace el commit del archivo. Se auditan intención y resultado
con ids y estados fijos, omitiendo nombre, remoto, rutas y contenido. Un fallo de
auditoría previo aborta. Un fallo posterior devuelve `created` con `audit_failed`
y conserva el archivo. El cliente recupera respuestas perdidas leyendo el estado.

Persisten los límites de mismo usuario del SO de §9. La validación de rutas y su
uso son llamadas separadas, por lo que un proceso hostil con acceso de escritura
simultáneo puede sustituir directorios entre ellas. El escritor concurrente del
mismo usuario queda fuera del límite de confianza de esta preparación. Esta
carrera de sustitución de directorios persiste como riesgo residual. JSONL y
filesystem tampoco comparten transacción. Un crash puede dejar intención de
auditoría, temporales o directorios pendientes de inspección. Revisar estas
condiciones al implementar
la separación de identidades de SA-058.

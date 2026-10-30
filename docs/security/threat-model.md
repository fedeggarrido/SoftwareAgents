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

## Riesgos principales

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

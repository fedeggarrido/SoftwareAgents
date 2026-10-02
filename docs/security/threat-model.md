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
  del agente y cierre de WebSearch/WebFetch en los perfiles del slice.
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

- **Descripción:** el CLI imprime `?token=` y la SPA lo transmite al WebSocket.
  Es una capacidad bearer reutilizable que puede quedar en historial, terminal y
  logs de Fastify; quien la obtenga puede enviar mensajes privilegiados.
- **Mitigación (SA-075):** redactar el token en los logs de Fastify y permitir
  rotarlo.
- **Aceptación temporal (SA-067):** aceptación explícita del transporte actual
  en uso local supervisado; tratar la URL como secreto y no compartirla. El bind
  por defecto a loopback y la comprobación del token existen, pero no evitan fugas
  ni convierten la posición de red en autorización.
- **Revisit when:** antes de exposición remota, compartir logs/URLs, o tras una fuga;
  reevaluar transporte, redacción de logs y renovación del token.

### 6. Sin sandbox de SO para Claude en Windows

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
  orquestador no hace merge. **Aceptación temporal (SA-067):** mantener el Gate humano de
  [AGENTS.md](../../AGENTS.md): revisión cruzada manual, hallazgos resueltos y tests
  verdes; Claude integra tras esa revisión dentro del flujo autorizado por Fede.
  Ningún Agent ejecutado por la Platform recibe autoridad de merge autónomo.
- **Revisit when:** cambien permisos Git/CI, reglas de integración o se proponga
  automatizar el merge; requerir una Human Decision antes de cambiar este Gate.

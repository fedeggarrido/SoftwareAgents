# SoftwareAgents: Claude ↔ Codex

Lee primero [CLAUDE.md](CLAUDE.md) (índice; detalle en [docs/reference/](docs/reference/)) y
[CONTEXT.md](CONTEXT.md) (glosario canónico, incluida la sección SoftwareAgents).
Este archivo fija el flujo de colaboración del Development Project.

## Trabajo por tarea

- Una tarea de ClickUp = una rama `sa/SA-###-slug` en `.worktrees/SA-###`.
  Trabaja solo dentro de su worktree; nunca hagas commits directos a `main`.
- Nunca tocar Fundtrinsic: sus archivos, datos y procesos quedan fuera del alcance.
- Codex implementa por defecto: Fede paga una cuota en Codex y otra en Claude, y
  así reparte el trabajo entre ambas en lugar de gastar las dos a la vez.
  Si Codex no está disponible (límite de uso o capacidad), Claude implementa en su
  lugar sin esperar; la revisión cruzada y la QA de Codex se hacen cuando vuelva.
  Claude revisa, hace commit en la rama de la tarea e integra. Cuando implementa
  Claude, Codex realiza la revisión cruzada; Claude hace commit e integra.
- Quien trabaja la tarea actualiza su estado en ClickUp al empezar, al pasar a
  revisión y al terminar la integración. Si falta acceso, informa a Fede;
  no declares la tarea completada mientras falten revisión o criterios.
- Entrega al revisor los archivos cambiados, decisiones y motivos, comandos de
  verificación con resultados, riesgos y dudas para Fede. No dejes notas temporales
  en el repositorio.

## Anti-slop quality rules (mandatory)

Apply these to every change by Claude or Codex; reviews block on them. Full rationale and the UI table: [reglas-antislop-y-thermos](docs/ux-audit-2026-11/reglas-antislop-y-thermos.md).

- **Code judo first**: simplify by deleting complexity, not moving it. No ad-hoc conditionals, one-off booleans/nullable modes or scattered special cases. Put them behind a helper, state machine or policy.
- **Canonical layer and reuse**: logic lives in its layer. Reuse existing helpers. No feature logic in shared paths. No identity wrappers or pass-through helpers.
- **Honest types**: no `as unknown as`. No `any`, and no `unknown` params or returns without need. Every type assertion carries a `// SAFETY:` reason. No silent fallbacks that hide unclear invariants.
- **Size and atomicity**: never grow a file past 1000 lines without decomposing. No partial updates that leave state half-written.
- **Devex**: call out any change to secrets, env vars, ports or required scripts.
- **Reviews (thermos style)**: report only what the diff adds or changes. Trace each finding end to end. Never inflate priority. Order: regressions/security > missed simplification and branching growth > boundaries/types > size > legibility. For medium or large changes, run two independent passes (bugs/security, quality/structure) and merge the findings.
- **UI**: no purple gradients, glow, glassmorphism or emoji used as icons. No colour-only status: use a StatusChip with icon and Spanish text. No body text under 14 px; the pixel font is for titles, buttons and numbers only. Every hover, focus, active and disabled state, and 44 px touch targets. Motion only with purpose (100–300 ms, reduced-motion respected). No filler copy, lorem ipsum, invented numbers or jargon in the Spanish UI.

## Revisión e integración

- La revisión cruzada es manual: Codex → Claude o Claude → Codex.
  Registra hallazgos, resultado y pruebas como comentario o ReviewReport en la PR
  cuando exista; en el flujo local, entrega ese informe antes de integrar.
- Todas las PRs usan la misma cuenta de GitHub, que no puede aprobar sus propias
  PRs. El comentario o ReviewReport documenta la revisión; no se exige una
  aprobación de GitHub. Resuelve los hallazgos antes de integrar.
- Commits con prefijo semántico y key como scope:
  `feat(SA-012): crear project brain`. Usa un asunto en minúscula.
- Tras revisión cruzada y tests verdes, Claude hace rebase de la rama sobre
  `main` local, vuelve a validar el resultado y la integra por fast-forward
  (`git merge --ff-only`).
- Sin PRs ni `gh` (decisión de Fede): tras integrar, Claude hace `git push origin main`
  después de pasar gitleaks. El enlace a ClickUp va en los comentarios de la tarea.

## Trabajo en paralelo: local y cloud

- Una sesión = una tarea. Al empezar, pon la tarea en «in progress» en ClickUp
  (es el claim) y parte de `main` recién traído (`git fetch`). No cojas una tarea que
  ya esté en curso ni una que dependa de otra sin integrar.
- Local trabaja en `sa/SA-###-slug` (worktree); una sesión cloud, solo en su rama
  `claude/...`, y deja en ClickUp el commit y la rama para integrar.
- **Solo la sesión local integra en `main`**: rebase de la rama sobre `main`,
  revisión cruzada de Codex, validación, `git merge --ff-only`, gitleaks y push. Cloud
  nunca hace push a `main`.
- Lo que necesita Codex, Windows o la oficina real con las cuentas del operador va a
  local; cloud no tiene Codex ni Windows y lo declara como pendiente en la tarea.
- Ficheros que chocan: `CLAUDE.md`, `core/asyncapi.yaml`, `server/src/constants.ts`,
  `docs/design/*`. Solo una tarea en curso a la vez cambia el contrato AsyncAPI; en
  un conflicto, `core/src/messages.ts` se regenera (`npm run asyncapi:generate`),
  nunca se resuelve a mano.
- Las sesiones cloud se preparan solas con `.claude/hooks/session-start.sh`
  (dependencias, gitleaks fijado y verificado por SHA-256, build completo).

## QA y fixes tras cada feature

- Después de integrar **cada feature** (cada tarea SA-###, no cada tanda) y antes de
  pasar a la siguiente:
  1. **QA de Codex** (solo lectura): comprueba cada criterio de aceptación de las
     tareas en ClickUp, casos límite y exploración del código; entrega un TestReport
     con severidad por hallazgo.
  2. **QA de Claude** (real): oficina en el navegador, ejecuciones reales de
     executors y worker, audit log y CLI.
  3. Los hallazgos van a una tarea `SA-QA-n · Fixes tras SA-###` que se implementa,
     revisa e integra **antes** de la siguiente feature. Si no hay hallazgos, se
     cierra vacía indicándolo.
- Solo un hallazgo bloqueante detiene la integración; el resto va a la tarea de fixes.
- Las ejecuciones manuales de Codex (QA, revisiones, implementación) se lanzan con
  `-c features.apps=false`. Sin ese flag, Codex recibe los conectores de la cuenta
  ChatGPT (Gmail, ClickUp, Sites, llamadas) aunque nadie los pida
  (`docs/security/web-access.md`).

## Worktrees y validación segura

- Los tests de webview-ui/test se type-checkean con tsconfig.node.json: nunca importes componentes .tsx; extrae la lógica a módulos DOM-free.
  Antes de entregar, ejecuta `cd webview-ui && npx tsc -b`.

- Los `node_modules` de los worktrees son junctions al repo principal: no escribas
  en ellos, no los borres recursivamente ni instales dependencias desde el worktree.
- Retira worktrees **solo** con
  `powershell -NoProfile -File scripts/remove-worktree.ps1 -Path .worktrees/<id>`:
  quita cada enlace sin tocar su destino, comprueba que no queda ninguno y solo
  entonces llama a git. Nunca uses `git worktree remove` directamente ni lo
  encadenes tras otro comando. En Windows, git sigue una junction que quede y, a
  través de los enlaces de workspaces de npm (`node_modules/pixel-agents -> server`),
  vacía el `node_modules` real y borra `server/` y `webview-ui/` del checkout
  principal (incidente del 2026-10-03).
- Guarda archivos sin BOM; ejecuta Prettier sobre lo tocado, ESLint cuando aplique,
  `npm run check-types` y las pruebas pertinentes antes de entregar a revisión.
- No modifiques `tsconfig*.json`, `vitest.config.ts` ni otra configuración del repo para
  esquivar el sandbox (cachés, buildinfo); usa redirecciones temporales y restáuralas.
- En tests del sandbox usa `$env:TEMP="$PWD\.vitest-tmp"; $env:TMP=$env:TEMP`
  y elimina ese directorio al acabar. Nunca mockees `os.tmpdir()` hacia el repo.
- Para tests que escriban en `~/.pixel-agents` o `~/.claude`, mockea `os.homedir()`
  hacia `process.env.HOME` como en `server/__tests__/configPersistence.test.ts`:
  Windows ignora `HOME` en `os.homedir()`. Nunca escribas en el perfil real.

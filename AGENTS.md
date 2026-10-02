# SoftwareAgents: Claude ↔ Codex

Lee primero [CLAUDE.md](CLAUDE.md) (arquitectura, módulos y validación) y
[CONTEXT.md](CONTEXT.md) (glosario canónico, incluida la sección SoftwareAgents).
Este archivo fija el flujo de colaboración del Development Project.

## Trabajo por tarea

- Una tarea de ClickUp = una rama `sa/SA-###-slug` en `.worktrees/SA-###`.
  Trabaja solo dentro de su worktree; nunca hagas commits directos a `main`.
- Nunca tocar Fundtrinsic: sus archivos, datos y procesos quedan fuera del alcance.
- Codex implementa por defecto: Fede lo prioriza porque le sale gratis.
  Claude revisa, hace commit en la rama de la tarea e integra. Cuando implementa
  Claude, Codex realiza la revisión cruzada; Claude hace commit e integra.
- Quien trabaja la tarea actualiza su estado en ClickUp al empezar, al pasar a
  revisión y al terminar la integración. Si falta acceso, informa a Fede;
  no declares la tarea completada mientras falten revisión o criterios.
- Entrega al revisor los archivos cambiados, decisiones y motivos, comandos de
  verificación con resultados, riesgos y dudas para Fede. No dejes notas temporales
  en el repositorio.

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
- Push y PR solo cuando Fede lo pida. El título de PR sigue la misma convención:
  `feat(SA-012): crear project brain`; cumple `.github/workflows/pr-title.yml`.
  El cuerpo usa la [plantilla existente](.github/pull_request_template.md) e incluye
  el enlace manual a la tarea de ClickUp mientras no exista SA-053.

## Worktrees y validación segura

- Los `node_modules` de los worktrees son junctions al repo principal: no escribas
  en ellos, no los borres recursivamente ni instales dependencias desde el worktree.
- Antes de `git worktree remove`, verifica las rutas absolutas y que cada
  `node_modules` sea una junction del worktree que vas a retirar. Retira cada enlace
  con `cmd /c rmdir "<ruta-absoluta-del-worktree>\node_modules"` **sin `/s`**
  (también los de los workspaces, si existen). Así conservas el `node_modules` real.
- Guarda archivos sin BOM; ejecuta Prettier sobre lo tocado, ESLint cuando aplique,
  `npm run check-types` y las pruebas pertinentes antes de entregar a revisión.
- En tests del sandbox usa `$env:TEMP="$PWD\.vitest-tmp"; $env:TMP=$env:TEMP`
  y elimina ese directorio al acabar. Nunca mockees `os.tmpdir()` hacia el repo.
- Para tests que escriban en `~/.pixel-agents` o `~/.claude`, mockea `os.homedir()`
  hacia `process.env.HOME` como en `server/__tests__/configPersistence.test.ts`:
  Windows ignora `HOME` en `os.homedir()`. Nunca escribas en el perfil real.

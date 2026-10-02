# SA-061: la autoridad del commit pertenece al runtime

Compilar la plantilla Developer existente evita duplicar prompts y mantiene
la misma restricción de herramientas en CLI y Executor. Sin Bash, los commits
y la validación de shell necesitan responsables externos: runtime y revisor.

La preparación automática del WorktreeManager no encaja con worktrees cuyos
node_modules son junctions. El worker supervisado omite instalación y escrituras
de configuración Git, conservando el comportamiento anterior para otros usos.

Un PID muerto no basta para recuperar un lock: el Executor hijo podría seguir
editando. La recuperación requiere comprobar ambos procesos y revisar cambios.
El fake CLI verifica el recorrido hasta commit/audit; Claude debe validar el
personaje y la ejecución real antes de integrar.

## Primer ciclo real (2026-10-02, SA-080)

- `pixel-agents worker run --task SA-080` lanzó Claude Code 2.1.161 como Developer, compilado desde `agents/templates/developer.yaml`. En la oficina apareció como «developer · SA-080» gracias al sessionId de ExecutionRegistry.
- El runtime hizo el commit en `sa/SA-080-worker` con el trailer de ejecución. `main` no se tocó, el push quedó bloqueado («softwareagents-push-disabled») y el audit registró `launch_execution`, actor `human`, `allow` y `ready_for_review`.
- Claude ejecutó tsc -b y los tests del webview (113/113). Codex hizo la revisión cruzada, con APPROVE y un hallazgo LOW sobre casos extra. La integración en main fue por fast-forward.
- Por pulir (SA-081): el asunto del commit se deriva del título del brief en minúsculas y repite la key; la etiqueta dice «developer» en vez de «DEV»; el directorio del worktree puede quedar bloqueado en Windows tras `git worktree remove` mientras la oficina lo vigila.

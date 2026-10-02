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

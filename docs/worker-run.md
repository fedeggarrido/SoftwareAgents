# Worker supervisado (SA-061)

Desde el checkout principal del Managed Project, con el paquete construido:

```text
pixel-agents worker run --task SA-### --brief ruta/al/brief.md
```

Los runs normales requieren Windows. En Linux y macOS, `worker run` rechaza
la plataforma antes de abrir WorkStore, reclamar una lease, sondear Executors o
preparar el worktree: SA-026 todavía no verifica la identidad y el cierre de
grupos POSIX. No basta con que un PID desaparezca. Los evals desechables conservan
su recorrido independiente, sin lease de Task.

El Operator debe autorizar `claude` en `projects.<project.id>.allowedExecutors`
de su configuración existente. `binaryPaths.claude` permite seleccionar el
ejecutable; el brief y `project.yaml` no conceden autoridad. La decisión de
`evaluatePolicy(launch_execution, human, operator.autonomyLevel)` se registra
mediante `recordAudit`, también en fallos y resultados sin cambios. A1 es
supervisado: el lanzamiento manual identifica al actor como `human`.

La admisión por cuota y slots se aplica también sin `--select-executor`. Para
configuraciones antiguas, el worker manual usa un slot si falta el límite y un
umbral de 0% si falta `quotaThresholds.claude`. Respeta los valores explícitos,
los rechazos vigentes y una única sonda con cuota desconocida. Las sesiones
interactivas de la oficina no consumen el límite del worker. El log declara
conteos y cobertura. [Detalles de admisión](executor-selection.md).

El runtime crea o reutiliza `.worktrees/SA-###`, rama `sa/SA-###-worker`, desde
la rama base declarada. Rechaza worktrees sucios antes de lanzar. No instala dependencias, pero mantiene el bloqueo de push del agente: activa `extensions.worktreeConfig` y fija un `remote.origin.pushurl` inválido solo para ese worktree. El Developer usa la plantilla
distribuida `agents/templates/developer.yaml`, validada y compilada por
`compileAgent` y el Executor, con Read/Glob/Grep/Edit/Write, sin Bash, git,
red, MCP ni delegación. La plantilla conserva su contrato genérico de commits;
en este slice los materializa el runtime. El agente tampoco puede ejecutar
tests de shell: Claude valida la propuesta en la revisión humana.

Tras una ejecución exitosa, el runtime verifica que HEAD y la rama no hayan
cambiado, añade los cambios y crea un commit `feat(SA-###): ...` con trailer
`SoftwareAgents-Execution`. Desactiva hooks Git **solo para ese comando** para
no ejecutar código del repo como parte del commit. Requiere identidad Git ya
configurada por el Operator: comprueba `git var GIT_AUTHOR_IDENT` y
`git var GIT_COMMITTER_IDENT` antes de admitir/reservar, sin escribir config.
Si falta, termina con error claro (exit 1), sin slot ni Execution. Un fallo
posterior de commit muestra un mensaje sin traza y conserva los cambios. Imprime «rama lista para revisión», rama, SHA y
`diff --stat`; si no hay cambios imprime «sin cambios» sin commit. Nunca hace
push, PR, merge, ni invoca `gh`. Los fallos retienen los cambios para inspección.
Las dependencias y los tests quedan para preparación y revisión humanas.

El asunto conserva las mayúsculas del primer título no vacío del brief y quita
su key inicial y separador: `# SA-081 · HUD: mostrar Capacidad` produce
`feat(SA-081): HUD: mostrar Capacidad`. La key permanece en el scope.

En Windows, la oficina u otro watcher puede bloquear el directorio vacío después
de que `git worktree remove` lo haya desregistrado. `WorktreeManager.cleanup`
intenta retirar ese residuo sin borrado recursivo; si sigue bloqueado informa
de su ruta. Cerrar los watchers y repetir cleanup más tarde. Un directorio no
registrado con contenido o un enlace se rechaza siempre. Antes de la retirada
manual, seguir las reglas de junctions de AGENTS.md; no usar borrado recursivo
sobre node_modules compartidos. El worker conserva su rama para revisión y no
llama a cleanup automáticamente.

## Lock y recuperación

Los runs normales usan la lease de WorkStore y la recuperación SA-026. El runtime
lanza un supervisor `detached: true` y `windowsHide: true`: en Windows queda fuera
del Job Object de libuv del worker con `KILL_ON_JOB_CLOSE`, sin ventana de consola.
El supervisor espera el registro duradero de su PID y hora de creación antes de
lanzar el CLI. Después del `close` del CLI, conserva su raíz hasta que el worker
persiste `tree_closed_at` bajo la lease y envía un segundo ACK. Si el worker muere
antes de ese ACK, la raíz permanece viva incluso tras cerrar el CLI, para que el
sweeper verifique su identidad y termine el árbol. Una raíz ausente o reutilizada
sigue bloqueando la recuperación; nunca se interpreta como cierre demostrado.
Si el worker muere después de persistir el cierre y antes del ACK, el sweeper
también recoge la raíz retenida si su identidad sigue coincidiendo; el cierre
ya persistido permite omitir un PID que haya desaparecido o se haya reutilizado.
La cancelación y el timeout del worker vivo siguen terminando el árbol mediante
`taskkill /T /F` y esperando `close` antes de liberar los recursos.

Los rechazos sucesivos de cuota conservan el reset futuro más tardío conocido,
aunque un evento posterior omita el reset. Los fallos retryable guardan categoría
fija (auth, spawn, containment, timeout, cancelled, lease, workspace o executor)
y código de salida, sin copiar rutas, prompts ni texto del modelo al motivo de Task.

El siguiente lock corresponde al recorrido de eval y a workers legacy:

El lock exclusivo `<git-common-dir>/softwareagents/locks/SA-###.lock` contiene
el PID del worker. Se libera al terminar normalmente. SIGINT/SIGTERM solicitan
cancelación del Executor; una terminación abrupta puede dejar el lock. Nunca se
roba por antigüedad ni por PID muerto: el hijo del Executor puede seguir vivo
y un PID puede reutilizarse.

Para recuperarlo, el Operator comprueba que **worker e hijo del Executor** han
terminado (PID y registros de `softwareagents/executions.jsonl`), inspecciona
el worktree y elimina únicamente ese fichero de lock. Si quedaron cambios,
los revisa y guarda antes de reintentar; el worker rechaza un retry sucio.
Un lock de PID muerto sigue bloqueando hasta esta recuperación explícita;
el test reproduce esa secuencia. No se borra el worktree automáticamente.

## Prueba real de Claude

Fede elige una tarea trivial real y su brief. Abrir la oficina en el checkout
principal y lanzar el worker manualmente. El personaje debe mostrar
`DEV · SA-###` usando el sessionId de `ExecutionRegistry`, con detección por
hooks instalados o transcript. No se añaden regex sobre el brief: la ruta
legacy del RoleResolver sigue intacta. Verificar commit y trailer, diff limpio,
audit con actor human y policyDecision allow, main intacto y ausencia de push.
La prueba automatizada usa `fixtures/fake-cli.cjs` y un repo Git temporal;
no ejecuta Claude real ni acredita la visualización en la oficina real.

Con catálogo de niveles, el worker manual registra cada intento admitido en el
WorkStore antes de preparar el worktree. Si la Task no existe, crea una referencia
DRAFT con `type: unknown`; la clasificación usa el fallback del tierRule.
Una Task existente conserva su lifecycle. La fila Execution comienza con Session
y PID nulos y recibe session_id cuando el Executor lo conoce (started en Codex).
Los intentos fallidos o cancelados conservan su fila. No se crea fila si espera
por cuota/concurrencia o falla el preflight de identidad Git.
El tope total maxExecutions cuenta slots de Claude y Codex bajo admisión en
orden Claude → Codex, también sin catálogo: ausente no añade tope y 0 espera.

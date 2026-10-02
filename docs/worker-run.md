# Worker supervisado (SA-061)

Desde el checkout principal del Managed Project, con el paquete construido:

```text
pixel-agents worker run --task SA-### --brief ruta/al/brief.md
```

El Operator debe autorizar `claude` en `projects.<project.id>.allowedExecutors`
de su configuración existente. `binaryPaths.claude` permite seleccionar el
ejecutable; el brief y `project.yaml` no conceden autoridad. La decisión de
`evaluatePolicy(launch_execution, human, operator.autonomyLevel)` se registra
mediante `recordAudit`, también en fallos y resultados sin cambios. A1 es
supervisado: el lanzamiento manual identifica al actor como `human`.

El runtime crea o reutiliza `.worktrees/SA-###`, rama `sa/SA-###-worker`, desde
la rama base declarada. Rechaza worktrees sucios antes de lanzar. No instala
dependencias ni modifica configuración Git. El Developer usa la plantilla
distribuida `agents/templates/developer.yaml`, validada y compilada por
`compileAgent` y el Executor, con Read/Glob/Grep/Edit/Write, sin Bash, git,
red, MCP ni delegación. La plantilla conserva su contrato genérico de commits;
en este slice los materializa el runtime. El agente tampoco puede ejecutar
tests de shell: Claude valida la propuesta en la revisión humana.

Tras una ejecución exitosa, el runtime verifica que HEAD y la rama no hayan
cambiado, añade los cambios y crea un commit `feat(SA-###): ...` con trailer
`SoftwareAgents-Execution`. Desactiva hooks Git **solo para ese comando** para
no ejecutar código del repo como parte del commit. Requiere identidad Git ya
configurada por el Operator. Imprime «rama lista para revisión», rama, SHA y
`diff --stat`; si no hay cambios imprime «sin cambios» sin commit. Nunca hace
push, PR, merge, ni invoca `gh`. Los fallos retienen los cambios para inspección.
Las dependencias y los tests quedan para preparación y revisión humanas.

## Lock y recuperación

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

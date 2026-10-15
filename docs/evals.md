# Banco de tareas y evaluación (SA-094)

Desde la raíz del checkout de SoftwareAgents, con dependencias ya disponibles:

```sh
pixel-agents eval list
pixel-agents eval validate --json
pixel-agents eval report --json
pixel-agents eval run --task telemetry-usage-replacement --executor codex --tier economy --repeat 1 --yes --json
pixel-agents eval run --task all --executor claude --tier standard --repeat 2
pixel-agents eval run --task telemetry-usage-replacement --executor codex --tier economy --repeat 1 --agent-spec ./developer-experiment.yaml --yes
```

Solo `run` consume cuota. Exige `--task`, `--executor`, `--tier` y `--repeat`
(1–20). Sin `--yes`, pregunta en un terminal interactivo mostrando el número
máximo de Executions: tareas seleccionadas × repeticiones. En un pipe se niega
sin `--yes`. Una cancelación no crea worktrees ni lanza sondas. `list`, `validate`
y `report` nunca lanzan CLI, sondas ni worker; también se pueden usar en CI.

`run` devuelve exit 0 si pasan todos los intentos, 1 ante fallo y 3 ante bloqueo
de admisión. Los rechazos de uso/configuración también devuelven 1.

## Declaraciones y verificadores

`.softwareagents/evals/*.json` está versionado. El esquema estricto está en
`core/schemas/eval-task.schema.json`: versión 1, `id`, `baseCommit`, `fixCommit`,
`brief`, `timeoutMin` (1–10), y `criteria: [{file, testName}]`. Todos los campos
son obligatorios; rechaza campos desconocidos también dentro de cada criterio.
No admite binarios, comandos de shell, modelos ni autoridad. `file` solo puede
nombrar un test de `server/__tests__`; `testName` es la expresión regular de
`vitest --testNamePattern`. La validación comprueba hashes completos, que la base
es el padre del fix y que los verificadores existen en ese commit. Necesita la
historia Git local, sin fetch implícito.

| Tarea                         | Reparación histórica                            | Criterio concreto                                                                 |
| ----------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `relay-first-snapshot`        | SA-QA-13, cursor inicial del relay              | `domainEventRelay.test.ts`: keeps transitions after the first successful snapshot |
| `effort-disabled-level`       | SA-QA-17, esfuerzo solo en niveles permitidos   | `modelTiers.test.ts`: skips effort validation for Claude levels                   |
| `levels-without-catalog`      | SA-QA-17, rechazo de restricciones sin catálogo | `configPersistence.test.ts`: rechazo aislado y mapa vacío legado                  |
| `telemetry-usage-replacement` | SA-QA-19, reemplazos después del límite         | `telemetry.test.ts`: Claude usage replacements                                    |
| `telemetry-root-slot`         | SA-QA-19, slot OTLP reservado al raíz           | `telemetry.test.ts`: saturated OTLP exporter                                      |

Son cambios de uno o pocos ficheros. El modelo recibe el brief, sin el patch ni
los hashes del fix. Al terminar el Executor, se restauran los tests fijados desde
`fixCommit`; modificar un test durante la Execution no altera el verificador.
Se usa Vitest ya instalado, con configuración propia, un worker de threads,
sin caché y con timeout de 60 s por criterio. Un filtro sin tests ejecutados falla.
Las pruebas `evalBank.test.ts` comprueban rojo en la base y verde en el fix,
sin llamar a modelos. Este banco histórico es una calibración local: el worktree
comparte el object store Git y no oculta la solución a un Executor que explore la
historia posterior; no es un benchmark ciego.

## Aislamiento y autoridad

Cada repetición crea un worktree **detached**, nuevo, en el commit base bajo
`<checkout principal>/.worktrees/eval-<uuid>`. No crea ramas, commits, instalaciones
de dependencias ni configuración Git. El worktree de invocación queda intacto.
El worker usa el Project y la política del checkout de invocación, no la política
histórica del worktree. La ruta interna de evaluación reutiliza `runWorker`:
compilador AgentSpec, selección SA-084/092, probes SA-089/090, revalidación de
autoridad, admisión de máquina/maxExecutions, slots, supervisor registrado,
Executors, registry y telemetría SA-095. No hay un segundo lanzador de modelos.
La evaluación no crea Tasks ni Human Decisions en el WorkStore.

Executor y nivel son exactos. Deben estar permitidos por `allowedExecutors`,
`executorLevels`, catálogo y `maxTier`; un bloqueo de cuota no cambia configuración
ni baja de nivel. Un bloqueo detiene la tanda. La configuración del Operator nunca
se modifica. Precios/modelos/esfuerzos salen exclusivamente de esa configuración.
`--agent-spec` carga y valida una declaración Developer alternativa con el mismo
techo de permisos del compilador; no amplía la autoridad externa.

`run` se niega si **CI está definido**, incluso vacío o `false`, o si está definida
alguna marca `SA_MANAGED_EXECUTION`, `SA_AUTOPILOT`, `SA_WORKER` o `CLAUDECODE`.
Todos los procesos de Executor (también sin registro) reciben e heredan
`SA_MANAGED_EXECUTION=worker`; el autopilot lanzado desde la oficina recibe
`SA_MANAGED_EXECUTION=autopilot`. Un supervisor externo iniciado por el operador
debe conservarla o establecer `SA_AUTOPILOT=1`. `--yes` no elude estas guardas.
Son guardas contra invocaciones automáticas accidentales, no un sandbox frente
a un proceso que quite deliberadamente sus variables de entorno.

Los verificadores tienen HOME, USERPROFILE, CODEX_HOME, TEMP y TMP temporales;
un setup de Vitest redirige `os.homedir()` a HOME también en Windows. La Execution
de modelo usa el perfil del operador como el worker habitual para autenticarse.
Las pruebas con CLIs falsas aíslan todos los perfiles. Solo tras cerrar el modelo
se añade un enlace a dependencias existentes para verificar: no se instala ni se
modifica su contenido. Cachés y configuración de verificación van al temporal.

La limpieza de Windows usa `scripts/remove-worktree.ps1 -DiscardChanges`, que
retira junctions antes de pedir a Git que descarte el árbol. En POSIX se retiran
los enlaces antes del borrado de Git. Si no se confirma el cierre del Executor,
se conservan worktree y locks para inspección del operador; no se borra un árbol
con un modelo posiblemente vivo. Un fallo de limpieza se comunica como error.

## Resultados e informe

Cada tanda escribe un JSONL propio, con append y fsync por repetición, en
`<Git common dir>/softwareagents/evals/<projectId>/<runId>.jsonl`, fuera del árbol
de trabajo. No se rotan automáticamente. Las filas tienen esquema estricto,
hashes de tarea/banco/AgentSpec, configuración, repetición, estado, booleanos de
criterios, duración, métricas proyectadas de SA-095 y, si existe, una copia de la
tarifa del Operator para el modelo resuelto. No contienen briefs, prompts,
salidas, errores crudos ni rutas de usuario. El registry de estas Executions
también omite eventos con contenido. Los temporales del verificador se eliminan.
El brief se pasa en memoria; los temporales de verificación están bajo
`<Git common dir>/softwareagents/runtime/evals/`, fuera de los resultados.
`executionId`, cuando hubo admisión, permite correlacionar la fila con el registry
y el raíz de SA-095 sin copiar contenido.

`report` se reconstruye exclusivamente desde estos JSONL. Cuenta líneas
incompletas/inválidas y duplicadas como `invalidLines`; conserva los demás datos.
Agrupa por versión de banco, executor, nivel, modelo/esfuerzo solicitados y hash
del AgentSpec. Expone intentos, bloqueos, éxitos/tasa, tokens de entrada/salida/
caché, tiempo y fases. Bloqueos sin lanzamiento no reducen la tasa de éxito.
Coste por tarea resuelta = **coste de todos los intentos / intentos exitosos**,
incluidos intentos fallidos en el numerador. Usa el cálculo de SA-095 y la tarifa
del Operator capturada en la fila; cambiar precios después no cambia el informe.
Sin tarifa, uso o modelo resuelto suficiente, el coste es `unknown`; sin éxitos,
el coste por resuelta es `unknown`. No inventa creación de caché para Codex.

Consistencia por tarea = todos los resultados éxito/fallo iguales si hay al menos
dos observaciones de la misma configuración y revisión de tarea; con una sola es
`unknown`. Consistencia de configuración = fracción de tareas repetidas consistentes.
Un fallo repetido puede ser consistente sin ser preciso. La frontera de Pareto
compara coste por resuelta (menor) y tasa (mayor), solo con igual banco y cobertura
de tareas; coste desconocido implica Pareto desconocido. Los porcentajes son
observaciones de muestras pequeñas, sin significación estadística inferida.

Un run sin `--agent-spec` establece muestras base. Los runs con spec alternativo
se comparan en `run` y `report` con las muestras base del mismo banco, tarea y
configuración. Una caída de tasa marca `regressions` y `regressionDetected=true`.
Sin una base comparable no se afirma mejora ni regresión. El test de regresión
lanza ambas CLIs falsas: pasan con el Developer base y fallan con un AgentSpec
inyectado; después reconstruye el informe desde disco y exige la marca.

## QA real de Claude

Con el catálogo del operador ya autorizado, ejecutar **solo una tarea y una
repetición en Codex economy** (primer ejemplo de `run`). Comprobar confirmación,
modelo/esfuerzo efectivos, slots liberados, resultado del criterio, tokens desde
el rollout, `report --json`, ausencia de contenido y retirada del worktree/junction.
No ejecutar `all` para esta QA inicial. Revisar también el rechazo en CI y desde
un worker/autopilot sin consumir cuota. La revisión cruzada e integración siguen
el flujo de AGENTS.md.

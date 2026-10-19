# Feature pipeline: Requirements, Architect y Developer (SA-041–043)

El primer paso convierte una petición del operador en un FeatureSpec revisable.
FEAT-001 es la **vista de auditoría en el Command Center**, por decisión del
operador. No incluye diseño técnico ni implementación de esa vista.

## Uso y prueba real de Claude

Desde el checkout **principal** de un Managed Project actualizado, en Windows,
con Node compatible con `node:sqlite`, identidad Git y Operator config ya
preparadas, construir con `node esbuild.js`. El comando exacto para la prueba es:

```powershell
node dist/cli.js feature spec FEAT-001 --request docs/examples/FEAT-001-request.md
node dist/cli.js feature show FEAT-001 --json
```

Equivalente instalado:
`pixel-agents feature spec FEAT-001 --request docs/examples/FEAT-001-request.md`.
El [request de ejemplo](examples/FEAT-001-request.md) contiene objetivo, alcance,
actores y casos límite. El request debe ser un archivo del checkout sin enlaces,
de hasta 1 MiB. No selecciona executor, modelo, autoridad ni herramientas.

El operador habilita los Executors mediante su configuración externa. El worker
reutiliza selección, cuota, sondas, revalidación antes del spawn, slots de máquina,
lease, supervisor, recuperación y auditoría de [worker run](worker-run.md) y
[executor selection](executor-selection.md). Sin catálogo de niveles usa las
preferencias `high_reasoning` existentes de
`.softwareagents/agents/model-policy.yaml`. Un único executor habilitado basta.
Las esperas de disponibilidad/cuota conservan el comportamiento y exit 3 del worker.

Claude debe comprobar en real:

1. Rol `requirements-analyst`, perfil `brain_write`, herramientas/flags de solo
   lectura y conectores/red/delegación desactivados. El agente devuelve la propuesta;
   el runtime escribe el documento. No hay instalaciones de dependencias.
2. `.worktrees/FEAT-001`, rama `sa/FEAT-001-worker`, commit con trailer
   `SoftwareAgents-Execution`, YAML válido y registro único en `features` con
   `doc_path`, `git_sha` del commit y `status=in_review`.
3. Criterios con Given/When/Then y `ears`; ausencia de cambios de código/diseño.
   Las preguntas de producto sin respuesta abren una Human Decision en el panel
   existente y dejan la Task de Requirements en `WAITING_HUMAN`.
4. Revisar el contenido y escribir las respuestas de producto en un Markdown del
   checkout principal (por ejemplo, `docs/examples/FEAT-001-answers.md`). Relanzar
   Requirements explícitamente desde el CLI humano:

   ```powershell
   node dist/cli.js feature spec FEAT-001 --answers docs/examples/FEAT-001-answers.md
   node dist/cli.js feature show FEAT-001 --json
   ```

   Equivalente instalado:
   `pixel-agents feature spec FEAT-001 --answers docs/examples/FEAT-001-answers.md`.
   El fichero debe existir, ser regular, estar dentro del checkout sin enlaces y
   ocupar como máximo 1 MiB. Las respuestas y el spec actual entran como datos
   no confiables; no conceden herramientas ni autoridad. Los mismos marcadores de
   ingreso gestionado/agente/autopilot que bloquean `approve` bloquean `--answers`.

   Requirements reutiliza la misma rama y worktree, incorpora las respuestas,
   elimina las preguntas respondidas y propone la siguiente versión de parche
   (`1.0.0` → `1.0.1`). El runtime valida la versión, materializa el YAML, lo
   commitea y actualiza `doc_path`/`git_sha`. Solo después del registro cierra la
   decisión anterior, vinculándola a versión, SHA y hash SHA-256 de respuestas;
   el contenido de las respuestas no se guarda en auditoría. Registro y cierre
   comparten transacción SQLite. Si falla la regeneración, la decisión conserva
   su gate y el artefacto anterior sigue registrado. Las nuevas preguntas abren
   una nueva decisión por versión, incluso si repiten texto de una versión previa.

   La opción de la oficina «Resolver todas las preguntas» por sí sola no incorpora
   respuestas al YAML y nunca permite aprobar mientras queden `openQuestions`.
   Cuando la nueva versión no tenga preguntas, ejecutar explícitamente:

   ```powershell
   node dist/cli.js feature approve FEAT-001
   node dist/cli.js feature show FEAT-001 --json
   ```

5. Confirmar `approved` y auditoría `approve_featurespec/pending` seguida de
   `approved`, actor humano. Repetir `feature spec` no lanza otro executor ni duplica
   Features/decisiones. Cambiar el YAML (también un comentario) debe impedir aprobar;
   un commit vacío posterior que conserve el YAML también debe impedir aprobar.
   Una decisión pendiente o expirada también lo impide.

Las pruebas automatizadas usan exclusivamente los fake CLIs de
`server/__tests__/fixtures/fake-requirements-cli.cjs`; Claude realiza la prueba real.

## Artefacto, contrato y reintento

El Brain vive en `project.yaml → brain.path`, relativo a cada checkout. En este
Project es `.softwareagents/brain`. La salida es siempre
`<brain>/features/<FEAT-ID>.yaml`, nunca una ruta elegida por el modelo. El registro
operativo vive en el WorkStore compartido del Git common dir, no en el Brain.
La Task de Requirements usa la key FEAT, tipo `docs` y el rol existente; no inventa
una Task SA ni duplica el estado del worker.

Se reutiliza el parser y esquema SA-013. `acceptance[].ears` es una ampliación
opcional para documentos antiguos; el nuevo paso exige ese campo en **cada**
criterio, además de `given`, `when` y `then`, IDs únicos y `status=draft`. EARS usa
la forma «When/While/Where …, the system shall …», «If …, then the system shall …»
o «The system shall …». La validación es estructural/sintáctica; la calidad y
coherencia semántica corresponden a la revisión humana.

Antes de aceptar una propuesta se serializa sin aliases y se comprueba que el
YAML persistido no supere el límite de lectura de 1 MiB. Una expansión de aliases
que lo exceda cuenta como error de validación y no produce artefacto registrado.

Si falla YAML, esquema o contrato de Requirements, el worker devuelve los errores
al mismo rol en una segunda Execution, con nueva admisión y auditoría. Conserva
la lease de la Task y el worktree limpio. Hay **un solo reintento de validación**;
un segundo fallo deja `FAILED_RETRYABLE` con motivo y sin Feature registrado.
Un fallo de executor o contención no recibe ese reintento de validación. La única
excepción transitoria de credenciales es el mensaje específico de Claude Code
«another Claude Code process is refreshing it»: espera cancelable de 30 segundos
y hasta dos reintentos, cada uno con nueva Execution, admisión y auditoría. Otros
errores de credenciales no se reintentan. La cascada de modelos
SA-103 no se aplica a Requirements: sus verificadores de implementación no
validan este artefacto y no deben multiplicar el límite de dos intentos.

`openQuestions: string[]` conserva el campo estructurado existente. Todas las
preguntas de una propuesta se agrupan en **una Human Decision**, con una clave
estable por contenido y versión, usando el gate existente (una Task no admite gates
simultáneos). Reejecutar no duplica la decisión. Aprobar comprueba además que
no queden preguntas en el artefacto, incluso si una decisión se marcó respondida
sin incorporar las respuestas o hubo un corte antes de abrir el gate.

## Contención y aprobación

Se conserva SA-062: Claude no dispone de Bash/Edit/Write y Codex corre en sandbox
`read-only`. El runtime materializa una propuesta ya validada. La guardia final
compara hashes de archivos versionados, ignorados y no versionados, rechaza enlaces
y cambios de HEAD/rama, y permite en el índice únicamente el YAML esperado.
Cualquier escritura del agente detectada falla y conserva evidencia; no se
revierten cambios ajenos automáticamente. Son defensas para trabajo local
supervisado: el [threat model](security/threat-model.md) conserva sus límites de
aislamiento de SO, escrituras transitorias/rutas fuera del worktree y carreras
frente a otro proceso del mismo usuario.

`approve_featurespec` reutiliza la política SA-019: solo ingreso humano del CLI,
sin flags de actor ni acciones desde el board. Los procesos gestionados/autopilot
se rechazan como agentes. La aprobación compara el fichero de trabajo, índice y
versión de la rama con el contenido del commit registrado. Además exige igualdad
entre el SHA registrado, HEAD del worktree y la ref de la rama, y comprueba decisiones
pendientes/expiradas dentro de la transacción de WorkStore. El `status=approved`
autoritativo es el de WorkStore: no se reescribe el YAML `draft` ni se altera el SHA
revisado para simular una aprobación del agente.

Git, SQLite y JSONL no comparten transacción. Un fallo después del commit Git o
antes de la confirmación de auditoría requiere inspeccionar los registros; no
prueba que la operación no sucediera. Un YAML previo sin registro no se sobrescribe.
Los worktrees sucios y leases pendientes siguen la recuperación/manual review
existentes. Este comando no integra, hace push ni retira worktrees.

## Architect: FeatureSpec aprobado → TechnicalDesign + TaskDAG (SA-042)

Después de aprobar el FeatureSpec, Claude ejecuta desde el checkout principal,
con el paquete construido (`node esbuild.js`) y Operator config existente:

```powershell
node dist/cli.js feature design FEAT-001
node dist/cli.js feature show FEAT-001 --json
```

Equivalente instalado: `pixel-agents feature design FEAT-001`. El comando exige
`features.status=approved`, igualdad del SHA aprobado con HEAD y la ref de la
rama, y contenido idéntico en disco, índice y commit. Revalida antes de lanzar.
No aprueba requisitos ni ejecuta las Tasks importadas (eso corresponde a SA-043).

Reutiliza worker, admisión, cuota, leases, supervisor, contención, compilador y
rol `architect` con `brain_write` efectivo de solo lectura. Usa la misma rama
`sa/FEAT-001-worker` y `.worktrees/FEAT-001` que Requirements, con una Task
operativa distinta `FEAT-001-DESIGN` de tipo `architecture`. La selección usa
`high_reasoning`; la cascada de verificadores de implementación no se aplica.
El contexto incluye el FeatureSpec aprobado y ARCHITECTURE, VISION, RULES y
CONSTRAINTS del Brain (archivos `.md`). Cada archivo ausente se transmite como
`null`, explícitamente ausente; no se inventa contenido. Las entradas siguen
siendo datos no confiables y no conceden autoridad.

La propuesta es un objeto JSON estricto: `components`, `risks`, `body`, `dag` y,
opcionalmente, `adrs: [{title, body}]`. No admite rutas, números de ADR ni status
elegidos por el modelo. El runtime materializa exclusivamente:

- `<brain>/technical-designs/FEAT-001.md`: front matter TechnicalDesign SA-014,
  versión `1.0.0`, status `proposed`, seguido del cuerpo Markdown.
- `<brain>/technical-designs/FEAT-001.dag.yaml`: TaskDAG SA-014 en YAML.
- Opcionalmente `<brain>/adr/NNNN-<título-normalizado>.md`: numeración única por
  Project, cuatro dígitos. El WorkStore reserva los números bajo transacción antes
  de materializar, por encima del máximo del Brain y de las reservas previas.
  Cada reserva queda ligada al Feature y sobrevive a fallos y reintentos.
  El runtime inserta referencias `ADR-NNNN` en el diseño. No sobrescribe
  artefactos previos sin registro.

Las keys son `FEAT-001-T##`. Cada Task exige tipo, tamaño S/M/L, dependencias,
`acceptanceRefs`, `changeZones` (rutas/globs relativos al repositorio, sin escapes)
y `parallelizable` booleano. Las rutas son POSIX relativas, con letras ASCII,
dígitos, `_`, `.`, `@` y `-`; `*` admite caracteres dentro de un segmento y `**`
ocupa un segmento completo (cero o más directorios). Se permite `/` final.
Se rechazan segmentos `.`/`..`, llaves, `?`, corchetes, rutas absolutas, letras de
unidad y backslashes. El prefijo de directorios anterior al primer glob debe
quedar físicamente dentro del checkout; se rechazan enlaces/junctions en él,
incluso cuando el resto de la ruta aún no existe. Se rechaza cualquier zona que
pueda cubrir `.git/`, `.softwareagents/`, `AGENTS.md`, las rutas SA-063 por defecto
o los `protectedPaths` externos del Operator, aunque la ruta protegida no exista.
Una ruta literal existente de directorio o con `/` final incluye descendientes.
Las demás rutas literales seleccionan solo esa ruta; un glob selecciona las
rutas que coincidan. Estos fallos son errores de validación y reciben el
mismo reintento único. `parseTaskDag` y `analyzeTaskDag` validan esquema,
keys únicas y del mismo Feature, dependencias existentes, ausencia de ciclos y
cobertura de **cada AC**. Las zonas y la marca se persisten en la declaración
inmutable; son datos para SA-097, no un permiso para lanzar en paralelo. Los DAG
históricos siguen aceptándose sin esos dos campos.

`testZones?: string[]` declara rutas o globs adicionales para los tests de la tarea.
Es opcional para conservar los DAG históricos; usa exactamente el esquema y las
validaciones físicas y de rutas protegidas de `changeZones`, y forma parte de la
declaración inmutable. Architect debe declarar aquí las raíces de tests que no
sean co-ubicadas ni el espejo `server/src/` → `server/__tests__/`.

Ante una propuesta inválida, devuelve errores deterministas al mismo rol una
sola vez, con otra Execution/admisión. El segundo fallo abre una Human Decision
y deja `FEAT-001-DESIGN` en `WAITING_HUMAN`, sin `FAILED_RETRYABLE` ni diseño
registrado. Repetir el comando no duplica el gate ni lanza otra Execution.
Para incorporar aclaraciones desde ingreso humano:

```powershell
node dist/cli.js feature design FEAT-001 --answers docs/examples/FEAT-001-design-answers.md
```

Ese Markdown debe existir dentro del checkout, ser regular, sin enlaces y de
hasta 1 MiB. Los marcadores de ingreso gestionado/agente bloquean `--answers`.
La decisión se conserva durante la regeneración; solo se cierra al registrar el
diseño y las Tasks, en la misma transacción SQLite, con SHA y hash de respuestas.
Un fallo conserva el gate. No se registra el texto de las respuestas en auditoría.

El runtime verifica las escrituras y los paths staged, crea un commit con trailer
`SoftwareAgents-Execution` y registra en `technical_designs` (migración v8)
`doc_path`, `dag_path`, `git_sha` y `feature_sha`. Conserva el SHA aprobado del
FeatureSpec. Registro e importación reutilizan `WorkStore.importTaskDag` en una
transacción: Tasks sin dependencias pendientes en READY, las demás en DRAFT.
`feature show` incluye diseño y decisiones; verifica el nuevo HEAD registrado y
que el spec aprobado no haya cambiado. Con diseño registrado, `task import` exige
el mismo conjunto completo de Tasks y contenido que el DAG del commit registrado:
rechaza altas, omisiones y cambios locales. El mensaje remite a `feature design`
para cambiar el diseño; la regeneración de un diseño ya registrado requiere un
flujo explícito de revisión, todavía no disponible. Solo los DAG históricos sin
diseño registrado conservan importación aditiva. El orden de Tasks, dependencias,
referencias AC y zonas no cambia el contenido. El reimport idéntico es un no-op y no
altera estados, versiones ni leases:

```powershell
Push-Location .worktrees/FEAT-001
node ../../dist/cli.js task import .softwareagents/brain/technical-designs/FEAT-001.dag.yaml
node ../../dist/cli.js task list --json
Pop-Location
```

Claude comprueba en real los flags de solo lectura de Architect, contexto real o
ausente, cobertura de AC, las únicas rutas creadas, numeración ADR, trailer/SHA,
READY/DRAFT y `0 created` al reimportar. El pipeline no integra ni hace push.
Git, SQLite y auditoría no comparten transacción: un corte tras commit y antes del
registro exige inspección manual; no se sobrescriben los archivos huérfanos.
La migración aditiva v9 añade la declaración completa del DAG registrado y las
reservas ADR por Project/Feature; los diseños v8 conservan sus declaraciones
inmutables como referencia al migrar. Antes de abrir la base v9, actualizar y
reiniciar coordinadamente todos sus
escritores como indica [task CLI](task-cli.md#migraciones-de-la-base-compartida).
Las pruebas automatizadas usan únicamente fake CLIs.

## Developer: Task READY → rama con commits para revisión (SA-043)

Después de aprobar el FeatureSpec y registrar el diseño, desde el checkout
principal, construir `node esbuild.js`. Comando para la prueba real de Claude:

```powershell
node dist/cli.js feature develop FEAT-001 --task FEAT-001-T01
node dist/cli.js feature show FEAT-001 --json
```

Equivalente instalado: `pixel-agents feature develop FEAT-001 --task FEAT-001-T01`.
Sin `--task`, selecciona la primera tarea `code`/`developer` del DAG en READY o WAITING_QUOTA
que cumple `canStart` (dependencias DONE). Ejecuta **una sola tarea**; no promueve
dependientes ni integra. Si no hay otra elegible, devuelve la referencia de revisión
ya existente. Con `--task`, un reintento devuelve la misma referencia sin volver
a lanzar al agente. Una tarea bloqueada, ajena al Feature o sin zonas se rechaza.
WAITING_QUOTA conserva las mismas validaciones de feature, diseño y dependencias;
WorkerLifecycle la devuelve a READY y reevalúa selección y disponibilidad.

Reutiliza worker, selección/cascada SA-103, leases y recuperación SA-026,
compilador y contención SA-062 con `branch_write`, guardia SA-063, commit con
trailer y transición a REVIEW. La rama es `sa/FEAT-001-T01-developer` y el
worktree `.worktrees/FEAT-001-T01`, desde la base declarada del Project.
Antes de crear la rama, el runtime registra el SHA de esa base en
`<git-common-dir>/softwareagents/task-bases/<rama-codificada>.json`. En cada
reintento, incluso al devolver `review_ref`, exige ese registro y que el merge-base
entre la rama y la base del Project coincida con el SHA registrado. Una rama
preexistente sin registro requiere reconciliación humana; no se adopta su HEAD
como base. Todas las guardias y `review_ref.base` usan el SHA registrado.
El contexto incluye el FeatureSpec aprobado, el diseño registrado, la tarea,
sus referencias AC y `changeZones`, siempre como datos no confiables. Se comprueban
SHA, disco, índice, rama y declaraciones importadas antes de admitir y de lanzar.

El rol pide un test de aceptación o reproducción antes de implementar. Antes de
verificar, después de verificar y antes del commit, el runtime comprueba el diff
completo contra la base (índice, disco, archivos nuevos e ignorados): solo admite
las zonas declaradas y tests JS/TS `*.test.*`/`*.spec.*` autorizados. Estos tests
deben estar en `changeZones`, ser co-ubicados con sus archivos fuente (retirando
`.test`/`.spec` de su nombre), ser su espejo `server/__tests__/` de `server/src/`,
o coincidir con `testZones`. El sufijo no autoriza rutas ajenas, ni siquiera para
borrar o vaciar suites existentes. Una zona literal que ya
era directorio en el checkout principal, o acaba en `/`, incluye descendientes;
los globs usan la gramática de Architect, incluido `**/` sin directorios.
Las rutas protegidas/configuración/dependencias, enlaces y cambios ignorados se
rechazan. Exige al menos un test no vacío con líneas añadidas; eliminar un test
o modificar únicamente fixtures no satisface el contrato. Cualquier rechazo
conserva el trabajo para inspección y no crea un commit.

Los verificadores usan los comandos del binding SA-103 de la tarea, o
`defaultVerifier`; sin ninguno, `tsc --noEmit --incremental false`. Se ejecutan
también cuando la cascada está desactivada. Además ejecuta los tests modificados
con Vitest instalado, configuración neutral externa, un worker y HOME/USERPROFILE
aislados, sin caché ni instalaciones. El reporter JSON escribe fuera del worktree:
cada fichero requerido debe aportar al menos un test ejecutado y aprobado. Los
tests y suites añadidos no admiten `skip`, `todo` ni `only`; una comprobación
estática con el parser de TypeScript exige `expect` o `assert` en el cuerpo de
cada test nuevo o modificado. Un test sin recoger o fallido impide el commit.
Los tests que requieren aliases/setup especiales necesitan adaptación explícita;
no se carga configuración del repositorio generada por el agente. Como SA-103,
esto valida agentes cooperativos y no confina código adversarial en el SO.

La comprobación roja sobre la base no se automatiza en este slice: aplicar tests
nuevos a otra base requiere un árbol separado y contexto de test compatible;
no se revierte código del worktree activo para simularlo. El agente debe declarar
esa limitación y Claude revisa el test y reproduce el rojo cuando corresponda.
Durante SA-043 se ejecutó primero el test de aceptación del nuevo CLI sobre la
implementación base: falló por `Usage` al no existir `feature develop`; después
pasó. La presencia de cambios de test y su ejecución verde no acredita su calidad
semántica ni demuestra el orden temporal de las ediciones.

WorkStore v10 añade `tasks.review_ref = {branch, sha, base}`, visible en
`feature show` (texto y JSON), ligado a la tarea. El commit y registro usan una
clave SA-026 por tarea/diseño: nunca se repite un efecto pendiente o incierto.
Un corte entre Git, SQLite y auditoría exige reconciliación humana; no crea una
rama alternativa ni descarta evidencia. Actualizar/reiniciar todos los escritores
antes de abrir la base v10, como en [task CLI](task-cli.md#migraciones-de-la-base-compartida).

No hay PRs, `gh`, merge ni integración automática. `push_main = deny` siempre.
Por defecto no publica ninguna rama. Solo Operator config externo puede activar:

```json
"developer": { "pushBranch": { "enabled": true, "remote": "origin" } }
```

El runtime resuelve el nombre del remoto en el checkout principal a una URL
explícita, revalida la rama y SA-063 y publica únicamente
`<sha>:refs/heads/sa/<TASK>-developer`, sin hooks ni refspecs implícitos. Ni siquiera
un remoto llamado `main` cambia ese destino. Publicar es idempotente por
tarea/SHA/nombre de remoto; un resultado incierto requiere reconciliación SA-026.
La contención del agente y su pushurl bloqueado se conservan. Un fallo de publicación
conserva la referencia local lista para revisión.

Claude comprueba en real el contexto/flags, tests, commit/trailer, `review_ref`,
main intacto y ausencia de push por defecto; repite el mismo comando y confirma
el mismo SHA y número de Executions. La QA automática solo usa CLIs falsas y
repositorios/remotos Git desechables.

## Próximos pasos

| Paso                 | Estado y contrato pendiente                                                     |
| -------------------- | ------------------------------------------------------------------------------- |
| Requirements Analyst | SA-041: petición → FeatureSpec validado → aprobación humana                     |
| Architect            | SA-042: FeatureSpec aprobado → TechnicalDesign y TaskDAG validados e importados |
| Developer            | SA-043: una tarea READY → rama y commits con tests y `review_ref`               |
| Reviewer             | Pendiente: revisión cruzada de los cambios                                      |
| QA                   | Pendiente: verificar criterios y pruebas reales antes de integrar               |

El importador [task CLI](task-cli.md) usa `features/<FEAT-ID>.yaml` si existe;
mantiene `features/requests/` como alternativa para documentos históricos.

# Feature pipeline: Requirements, Architect, Developer, Reviewer, QA y Orquestador (SA-041–046)

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
incluso cuando el resto de la ruta aún no existe. Se rechaza una zona si su
prefijo fijo es o está dentro de una ruta protegida anclada (`.git/`,
`.softwareagents/`, `AGENTS.md`, rutas SA-063 por defecto o `protectedPaths`
externos del Operator sin comodín inicial), aunque esa ruta no exista. También se
rechazan segmentos protegidos nombrados explícitamente, como `foo/.codex/bar`,
`src/**/.codex/*` o `foo/.git/config`. Los patrones recursivos con `**/` inicial
no invalidan un directorio solo porque podría contener un descendiente protegido:
`webview-ui/test`, `e2e/` y `server/src/**` son válidos con `**/.codex/**` protegido.
Declarar una zona no autoriza esos descendientes: tanto la guardia de zonas del
Developer como la guardia de commit SA-063 aplican todos los patrones fichero a
fichero y rechazan, por ejemplo, `webview-ui/test/.codex/x` dentro de una zona válida.
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
Sin `--task`, selecciona la primera tarea `code`/`developer` o con rol `qa`, `test`
o `qa-author` del DAG en READY o WAITING_QUOTA
que cumple `canStart` (dependencias DONE). Ejecuta **una sola tarea**; no promueve
dependientes ni integra. Si no hay otra elegible, devuelve la referencia de revisión
ya existente. Con `--task` y `review_ref` ya registrado, devuelve la misma referencia
sin volver a lanzar al agente. Una tarea bloqueada, ajena al Feature o sin zonas se rechaza.
WAITING_QUOTA conserva las mismas validaciones de feature, diseño y dependencias;
WorkerLifecycle la devuelve a READY y reevalúa selección y disponibilidad.

Reutiliza worker, selección/cascada SA-103, leases y recuperación SA-026,
compilador y contención SA-062 con `branch_write`, guardia SA-063, commit con
trailer y transición a REVIEW. La rama es `sa/FEAT-001-T01-developer` y el
worktree `.worktrees/FEAT-001-T01`, desde la base declarada del Project o desde
la rama de integración registrada por `feature run` (SA-046).
Antes de crear la rama, el runtime registra el SHA de esa base en
`<git-common-dir>/softwareagents/task-bases/<rama-codificada>.json`. En cada
reintento, incluso al devolver `review_ref`, exige ese registro y que el merge-base
entre la rama y la base del Project coincida con el SHA registrado. Una rama
preexistente sin registro requiere reconciliación humana; no se adopta su HEAD
como base. Todas las guardias y `review_ref.base` usan el SHA registrado.
El contexto incluye el FeatureSpec aprobado, el diseño registrado, la tarea,
sus referencias AC y `changeZones`, siempre como datos no confiables. Se comprueban
SHA, disco, índice, rama y declaraciones importadas antes de admitir y de lanzar.

`feature develop <FEAT-ID> --task <KEY>` permite reintentar explícitamente una tarea
de código en FAILED_RETRYABLE, sin `review_ref`, con las mismas validaciones de
feature, diseño y dependencias. Sin `--task` no selecciona fallos para reintentar.
Para fallos del agente/verificadores, el claim incrementa `attempt` de forma atómica; si el siguiente intento alcanza
`max_attempts`, queda en FAILED_FINAL para revisión humana sin lanzar el executor.
Reutiliza rama, worktree y base registrada. Tras confirmar el cierre de procesos y
adquirir el claim, descarta los cambios fallidos hasta el último commit registrado
en ReviewReport/TestReport o la base si no hay uno. Un HEAD distinto exige
reconciliación humana. Antes de reset/clean inspecciona con lstat y retira cada enlace
sin recorrerlo (incluidas junctions); conserva sus destinos.
Tras un `feature rebase`, el nuevo tip registrado también es una entrada válida
para ese reintento; el historial conserva las referencias a las bases anteriores.

Una infracción de zonas registra `change_zones_exceeded` y todas las rutas relativas
ofensivas, escapadas en JSON, en auditoría y en el motivo de la tarea.
También persiste `missing_test` y `guard:developer_changes` con el detalle saneado
de la guardia. Estos rechazos permiten una corrección con `previousFailure`, sin
gastar el presupuesto del agente. Repetir la misma categoría (y el mismo detalle
para guardias genéricas) deja WAITING_HUMAN con `gate: repeated_guard`, conserva
los cambios y detiene `feature run` con exit 3. Requiere intervención humana y un
reset explícito a READY; relanzar el run no abre otro intento.
Los errores de infraestructura del verificador detienen el run sin gastar intentos;
los errores de executor de autenticación, spawn, timeout, lease o workspace abren
un gate humano. No se convierten en FAILED_FINAL por reintentos automáticos.
Cada `cascade_attempt` registra `exitCode` (null solo sin evento finished),
`result` y `reason` en caso de fallo: `guard_rejected`, `infrastructure_error`,
`criteria_tampered`, `runtime_error`, fallo de verificador o del executor.
Un fallo posterior a un finished con exit 0 conserva ese 0; el motivo identifica
la causa sin guardar salida bruta del verificador.
`task list` y `feature show` exponen `last_developer_failure`. El siguiente contexto
incluye `previousFailure` y `allowedScope`: zonas exactas, directorios efectivos,
`testZones` y patrones de espejo permitidos. Son datos no confiables, sin autoridad.

El rol pide un test de aceptación o reproducción antes de implementar. Antes de
verificar, después de verificar y antes del commit, el runtime comprueba el diff
completo contra la base (índice, disco, archivos nuevos e ignorados): solo admite
las zonas declaradas y tests JS/TS `*.test.*`/`*.spec.*` autorizados. Estos tests
deben estar en `changeZones`, ser co-ubicados con sus archivos fuente (retirando
`.test`/`.spec` de su nombre), ser su espejo `server/__tests__/` de `server/src/`,
o coincidir con `testZones`. **Para `core/src/`, los tests van en
`server/__tests__/core/`, conservando el subdirectorio y el nombre de origen con
sufijo `.test` o `.spec`** (p. ej. `core/src/messages.ts` →
`server/__tests__/core/messages.test.ts`). Se permiten las variantes del mismo
nombre que anuncian los patrones de espejo. Este espejo se comunica en
`allowedScope.mirroredTestZones` y `coreTestRule`, incluso sin `testZones`.
No se admiten tests en `core/src/` ni otra raíz `core/`, tampoco mediante una
zona amplia o explícita: no existe runner core. Vitest related de fuentes core
usa el workspace server y sus tests espejo. El sufijo no autoriza rutas ajenas, ni siquiera para
borrar o vaciar suites existentes. Una zona literal que ya
era directorio en el checkout principal, o acaba en `/`, incluye descendientes;
los globs usan la gramática de Architect, incluido `**/` sin directorios.
Las rutas protegidas/configuración/dependencias, enlaces y cambios ignorados se
rechazan. Exige al menos un test no vacío con líneas añadidas; eliminar un test
o modificar únicamente fixtures no satisface el contrato. Cualquier rechazo
conserva el trabajo para inspección y no crea un commit.

Regla efectiva de espejo: se conserva el subdirectorio relativo de `server/src/`
en `server/__tests__/`, la extensión JS/TS de la fuente y el prefijo completo del
nombre; se admiten sufijos de variante antes de `.test` o `.spec`.
Por ejemplo, `server/src/clientMessageHandler.ts` permite
`server/__tests__/clientMessageHandler*.test.ts` y
`server/__tests__/clientMessageHandler*.spec.ts`, sin incluir subdirectorios nuevos.
Los globs de fuente conservan su alcance al transformarse; una zona de directorio
permite sus tests espejo descendientes. Los tests co-ubicados siguen quitando
únicamente `.test`/`.spec` para comprobar su fuente contra `changeZones`.

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
no se carga configuración del repositorio generada por el agente. QA, Developer y
`vitestRelated` resuelven cada fichero en `server/` o `webview-ui/`, con raíz y
directorio de trabajo del workspace. Los perfiles neutrales reproducen el entorno
Node y la selección de tests de sus configuraciones: globals en server y imports
explícitos en webview. Las tandas mixtas se separan por workspace; una raíz distinta
se rechaza antes de ejecutar comandos. Como SA-103,
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

Los subcomandos individuales no crean PRs ni integran. `feature run` puede
integrar en la rama del feature (SA-046); `push_main = deny` siempre.
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

## Actualizar la base de una tarea (SA-QA-36)

Cuando avanza la rama base del Project, el operador humano puede actualizar una
tarea desarrollada sin editar manualmente `task-bases` ni `review_ref`:

```powershell
pixel-agents feature rebase FEAT-001 --task FEAT-001-T03
pixel-agents feature show FEAT-001 --json
```

El comando exige una tarea sin lease en REVIEW o QA, con `review_ref` válido,
rama y HEAD iguales al SHA registrado y su worktree limpio. Incluye archivos
ignorados y no versionados: rechaza los residuos nombrando sus rutas, sin
eliminarlos. Los mismos marcadores de ingreso gestionado que bloquean `approve`
y `--answers` impiden el `rebase` directo. El run autorizado por el operador
puede invocar ese mantenimiento dentro del ciclo SA-046; no hay un flag de actor.

Toma el tip local actual de `project.repo.defaultBranch`, sin fetch implícito.
Prepara el rebase en un worktree separado, sin executors, hooks ni instalaciones.
Un conflicto aborta allí y conserva la rama, el worktree y los registros originales.
Compara `git patch-id --stable` del diff completo `base..sha` antes y después.
Si coincide, mantiene el estado y la vigencia de las aprobaciones de revisión/QA;
los informes y artefactos originales permanecen inmutables y la cadena de rebases
equivalentes vincula su referencia con la actual. Si cambia, vuelve a REVIEW y
las aprobaciones anteriores solo cuentan como historial: exige una nueva revisión.
La equivalencia del patch no sustituye la prueba real sobre la base actual.

Publica rama, índice/archivos del worktree, base confiable y `review_ref`
`{branch, sha, base}` bajo el bloqueo de escritura de WorkStore y compara la
versión de la tarea. Un fallo de publicación revierte Git y el registro y hace
rollback SQLite. Git, filesystem, SQLite y auditoría no tienen una transacción
distribuida: un marcador persistente `.rebase` junto al registro bloquea todos
los consumidores de la base durante la publicación. Si el proceso se interrumpe,
se conserva para reconciliación. SA-046 reconoce los dos estados conocidos del
journal bajo el bloqueo de WorkStore; cualquier edición ajena exige intervención
humana. Los eventos de WorkStore y auditoría `feature_rebase` conservan
SHA/base anteriores y nuevos y ambos patch-id. `feature show` expone la base nueva
en `review_ref`; Developer, Reviewer y QA reutilizan ese registro actualizado.
No integra ni publica ramas.

## Reviewer: revisión cruzada → QA o rework (SA-044)

Desde el checkout principal actualizado, construir `node esbuild.js`. Claude hace
la prueba real sobre la tarea y rama de Developer ya registradas:

```powershell
node dist/cli.mjs feature review FEAT-001 --task FEAT-001-T01
node dist/cli.mjs feature show FEAT-001 --json
```

Equivalente instalado: `pixel-agents feature review FEAT-001 --task FEAT-001-T01`.
La rama esperada es `sa/FEAT-001-T01-developer`. Sin `--task`, toma la primera
tarea del Feature en REVIEW con `review_ref`. Requiere FeatureSpec aprobado,
diseño y declaración inmutables, base confiable, rama y HEAD iguales al SHA
registrado y worktree limpio. Revalida antes de lanzar y antes de persistir.
Un SHA cambiado se rechaza; nunca se revisa silenciosamente otro commit.

El runtime calcula `review_ref.base..review_ref.sha`, sin external diff ni
textconv, con un máximo de 1 MiB; si lo excede, falla sin truncar el contexto.
El Reviewer recibe el diff, los archivos afectados, el FeatureSpec aprobado,
el diseño y la tarea con sus AC y changeZones como datos no confiables. Reutiliza
el worker, leases/recuperación, selección SA-036/090/092, cuota, slots,
revalidación, `agentCompiler` y contención. El rol es `reviewer`, perfil
`read_only`: solo executors con herramientas de lectura sin ejecución de código,
hoy Claude con Read/Glob/Grep, sin Bash, conectores, red ni delegación. Codex queda
excluido también de Reviewer: su sandbox `read-only` conserva shell general y no
hay mediación previa que limite sus comandos a lectura. Detectar `command_execution`
en el stream después de iniciarlo no impide ejecutar código. La exclusión
`code_execution_not_mediated` queda en la selección y su traza; sin candidato
admisible se abre la Human Decision de selección en WAITING_HUMAN, conservando
`review_ref` y la fase anterior para reevaluar. La guardia de hashes de Requirements detecta
escrituras incluso en ignorados; falla conservando evidencia. No acredita un
sandbox de SO para Claude ni evita escrituras transitorias de procesos ajenos.

Agent ≠ Model: entre candidatos permitidos del nivel/capacidad seleccionado,
prefiere un **executor distinto** al del último intento del Developer cuando
su sonda está disponible. Si no hay alternativa disponible y autorizada, usa
el mismo; la razón `cross_executor` o
`same_executor_no_available_alternative`, ambos executors y el rol quedan en
auditoría, `executions.selection_reason` y telemetría sin contenido. Los gates
normales de cuota/concurrencia se mantienen; una espera no habilita un fallback
por cuota. No aplica la cascada SA-103 al Reviewer: sus verificadores de
implementación no validan un informe. El Developer conserva su cascada durante
el rework, preservando los commits anteriores y la base original del diff.

La salida pasa por `extractJsonObject` y el esquema
`core/schemas/review-report.schema.json`. `request_changes` exige un finding
`blocker` o `major`; `approve` no los admite. Cada finding incluye fichero del
diff, severidad, resumen, sugerencia y línea positiva opcional. `acCoverage`
opcional solo admite AC de esa tarea y sin duplicados. Un informe inválido
recibe exactamente un reintento con errores y nueva Execution/admisión; el
segundo fallo devuelve la tarea a REVIEW y conserva `review_ref`.

Un fallo de infraestructura del Reviewer (OAuth, auth, spawn, timeout, cuota o
lease expirado) también conserva REVIEW, `review_ref` y `attempt`, sin consumir
rondas de rework. Solo un ReviewReport válido puede rechazar o aprobar el trabajo.
`task list` y `feature show` exponen `last_review_failure`, con motivo saneado y
fecha del último intento fallido, persistido en los eventos y en auditoría del
worker. `feature review` recupera también tareas históricas en FAILED_RETRYABLE
con `review_ref` válido cuyo último intento era Reviewer; las devuelve a REVIEW
al adquirir el claim, conservando las validaciones de SHA, base y worktree.

Un rechazo válido guarda el informe, limpia `review_ref` y pasa a READY con
`attempt + 1`. El siguiente `feature develop` recibe `reviewFindings` y
`reworkAttempt`, reutiliza la misma rama/worktree y registra un nuevo commit y
SHA. `REVIEW_MAX_REWORK_ROUNDS = 3`: permite tres reworks automáticos; el cuarto
rechazo guarda el informe y abre una Human Decision en WAITING_HUMAN sin otro
incremento. Informe, transición y decisión por tope son una transacción SQLite.
Una aprobación pasa a **QA**, estado existente; QA se ejecuta explícitamente con `feature qa` (SA-045). Nunca declara DONE ni integra.

WorkStore v11 añade `tasks.review_reports` (histórico con informe, `review_ref`,
Execution y ambos executors) y `executions.agent_role`. El histórico aparece en
`feature show` tanto en texto como JSON; sustituye el comentario de PR con
auditoría `review_report_pending`/`review_report_persisted`. Actualizar y reiniciar
todos los escritores antes de abrir v11 según
[task CLI](task-cli.md#migraciones-de-la-base-compartida). Git y auditoría no
comparten transacción con SQLite: si falta la confirmación de auditoría,
inspeccionar WorkStore antes de reintentar. No se usa `gh`, ni PR, push o merge.

Claude comprueba en real la exclusión de Codex para Reviewer, la selección de
Claude (cruzada cuando Developer usó Codex), flags de solo lectura, informe y
traza, QA tras aprobación y, ante
rechazo, los findings en el siguiente `feature develop`. La prueba automatizada
solo usa CLIs falsas y repositorios Git desechables; la prueba real corresponde
a Claude antes de integrar.

## QA: criterios, comandos del runtime y defectos trazables (SA-045)

Con FEAT-001-T01 ya en QA y su review aprobado, Claude realiza la prueba real
desde el checkout principal, con Operator config autorizada y el build actualizado:

```powershell
node esbuild.js
node dist/cli.mjs feature qa FEAT-001 --task FEAT-001-T01
node dist/cli.mjs feature show FEAT-001 --json
```

Equivalente instalado: `pixel-agents feature qa FEAT-001 --task FEAT-001-T01`.
Sin `--task`, selecciona una tarea del Feature en QA. Exige el último ReviewReport
aprobado para exactamente el mismo `review_ref`, SHA/base/rama y worktree limpio;
revalida antes del spawn y al persistir. No ejecuta Developer ni hace merge o push.

Reutiliza el ciclo de Reviewer/worker, admisión, selección, cuota, lease, reintento
único de informe, compilador y contención. `test_analysis` admite preferencias
propias; los Projects históricos reutilizan el orden `review` si no la declaran. El rol es `qa`, perfil `read_only`:
solo Claude Read/Glob/Grep, sin Bash, conectores, red ni delegación. Se excluye
Codex antes del lanzamiento por `code_execution_not_mediated`, igual que Reviewer:
`read-only` no elimina su shell general. Sin executor admisible, la selección
abre WAITING_HUMAN conservando el SHA aprobado y la fase QA para reevaluar.
El agente intenta romper cada AC asignado mediante lectura y razonamiento sobre
código, diff y resultados; nunca recibe Bash ni autoridad para ejecutar tests.

El runtime deriva un conjunto cerrado de 1–32 tests versionados de
`server/__tests__/`, `webview-ui/test/` y `e2e/`: tests del diff, de `testZones` y de
`changeZones`, incluidos los espejos `server/src/` → `server/__tests__/`
(mismo directorio relativo y variantes con sufijo) y
`webview-ui/src/<ruta>/<nombre>.ts` → `webview-ui/test/<nombre>*.test.ts`.
Para zonas de directorio o glob del webview solo se derivan los espejos de sus
fuentes versionadas; nunca se amplía implícitamente a todo `webview-ui/test/`.
Un directorio completo de tests solo se ejecuta si la tarea lo declara en sus zonas.
Cada fichero se ejecuta con Vitest y JSON reporter neutral, sin cargar configuración
ni reporters del repositorio. Usa el verificador compartido de evals SA-QA-20:
entorno por allowlist, perfiles/caché temporales, mock de os.homedir en Windows,
60 segundos y 1 MiB por comando/informe, terminación del árbol e integridad antes
y después. Solo enlaza las dependencias existentes durante la verificación y
retira su propio enlace sin recorrerlo; no instala dependencias. Un cierre sin
confirmar conserva temporales, enlace, lease y slot para inspección.
Los límites de aislamiento de SO siguen siendo los de [evals](evals.md#límites-de-seguridad).

Las configuraciones neutrales exigen `test.expect.requireAssertions: true` en QA,
evals, Developer test-first y la cascada `vitestRelated`: un test vacío o con su
única aserción en una rama no ejecutada falla.
El setup neutral cuenta también las llamadas ejecutadas a `node:assert` y
`node:assert/strict` (incluidos sus alias sin `node:`), delegando en los originales;
importar el módulo o crear un `AssertionError` no cuenta como aserción.
Configuración, perfiles, cachés e informes del runtime se crean en scratch y se
retiran tras confirmar el cierre.
La integridad nunca excluye nombres como `allure-results` o `.vite`; el diagnóstico
incluye la ruta relativa escapada y distingue «residuo previo a la verificación»
de «cambio durante la verificación». Un residuo previo es fallo de infraestructura:
conserva QA y no consume rondas.

Los resúmenes `commands[{command,result,passed,failed}]` llegan al agente como datos,
sin stdout/stderr. Ejecuta todo el conjunto declarado antes del agente. QA puede
pedir **una** tanda adicional para reproducir resultados, devolviendo únicamente
`{requestCommands: [IDs de commandAllowlist]}`. Solo admite IDs de esos comandos
del runtime, sin duplicados; después la allowlist queda vacía y exige el informe
final. Cada tanda usa nueva Execution/admisión y se añade a la evidencia. No acepta
argv, shell ni comandos nuevos propuestos por el modelo o por el Brain. Fuera de esas
raíces o por encima del límite, requiere acotar/declarar tests compatibles antes
de reintentar. Los e2e se acotan al spec concreto con las condiciones de
[QA author](#qa-author-tareas-de-tests-del-dag-sa-107); nunca lanza una suite completa.

La salida pasa por `extractJsonObject` y `test-report.schema.json`. Exige exactamente
una entrada por AC asignado con `pass|fail|not_tested|deferred` y evidencia no vacía,
comandos idénticos a la evidencia del runtime y defectos con AC, severidad,
resumen y reproducción. Cada AC fallido exige al menos un defecto enlazado.
No admite pass con tests fallidos o AC no probados. `not_tested` conserva QA
sin consumir rondas ni desbloquear dependencias.

Un AC compartido fuera del alcance de la tarea puede marcarse `deferred`, usando
`evidence` para justificarlo. El runtime solo lo acepta si el DAG registrado y
validado asigna el mismo AC a una tarea descendiente (dependencia transitiva) que
aún no está DONE. Revalida esa cobertura al persistir; sin ella lo convierte en
`not_tested` y conserva QA. Con el resto de AC y comandos en pass, un informe con
deferred permite DONE. El histórico `test_reports`, visible en `feature show`,
conserva el AC y su justificación. La QA posterior debe cubrirlo: solo puede
volver a diferirlo si existe otra tarea posterior pendiente que también lo cubra.
`feature qa --task` permite repetir QA tras `not_tested`, conservando los informes
anteriores, la referencia aprobada y las rondas de rework.

Un fail válido crea bugs `<TASK>-D<n>` en WorkStore con `defect_context`: tarea
original, AC, `review_ref` y Execution del informe. Original e informes conservan
la trazabilidad; la tarea vuelve a READY (rework), limpia su `review_ref` y suma
una ronda. El siguiente Developer recibe los defectos y reutiliza su rama/base.
Reviewer y QA comparten las tres rondas de SA-044: al superar el límite se
persisten informe y bugs y se abre WAITING_HUMAN sin otra ronda automática.
Un pass válido deja DONE, con `review_ref` aprobado (lista para merge humano), y
promueve a READY las tareas DRAFT del DAG cuyas dependencias estén todas DONE.
Los bugs son registros de seguimiento del rework de la tarea original; no se
introducen como nodos ejecutables del DAG ni se cierran sin verificación humana.
Repetir un defecto para la misma tarea, SHA y AC con el mismo resumen y reproducción
normalizados (Unicode NFKC y espacios) reutiliza el bug existente. La severidad no
crea una identidad distinta; cada TestReport y su artefacto permanecen como evidencia
independiente en el histórico de la tarea original.

WorkStore v12 persiste `tasks.test_reports` y `defect_context`; antes de abrirla,
actualizar/reiniciar los escritores como indica [task CLI](task-cli.md#migraciones-de-la-base-compartida).
Ubicación alternativa deliberada del artefacto: el **Brain operativo compartido**,
`<git-common-dir>/softwareagents/brain/test-reports/<TASK>/<Execution>.json`.
Cada fichero inmutable contiene informe y vínculos y aparece con `artifact_path`
en `feature show` (texto y JSON). Se elige esta ubicación fuera de los checkouts
para conservar el SHA aprobado y la inmutabilidad de FeatureSpec/diseño: el runtime
no añade commits de informes a las ramas de código o del Feature. No hay informe
versionado en Git. SQLite y filesystem no comparten transacción: un corte tras
escribir el fichero puede dejar un artefacto huérfano; WorkStore es la referencia
autoritativa y nunca se sobrescribe un huérfano automáticamente.

OAuth/auth, cuota, spawn, timeout, informe inválido tras dos intentos, lease perdida,
JSON ausente/vacío o tests omitidos conservan QA y `review_ref`, sin consumir rondas.
`last_review_failure` conserva el diagnóstico saneado del último fallo de revisión/QA;
se limpia en cuanto se persiste un informe válido, se completa Developer con
éxito o la tarea avanza a READY/FAILED_RETRYABLE tras reset o rework. Los fallos nuevos de QA usan `QA failed:` y `qa_validation_failed`. Los lectores
conservan compatibilidad con los fallos históricos etiquetados como Reviewer.
El diagnóstico visible `last_developer_failure` también se limpia tras
completar Developer, Reviewer o QA con éxito. Los eventos y la auditoría conservan
los fallos originales.

Claude comprueba en real los flags, resumen de tests del runtime, TestReport y
artefacto, DONE con review_ref aprobado y T02 READY. Las pruebas automatizadas
solo usan CLIs falsas y repositorios/perfiles desechables. La revisión cruzada,
QA real e integración siguen pendientes hasta que Claude las valide.

## QA author: tareas de tests del DAG (SA-107)

`feature develop` enruta los roles declarados `qa`, `test` y `qa-author` al
AgentSpec `qa-author`, perfil `branch_write`. La declaración del DAG no cambia.
Reutiliza Developer: rama `sa/<TASK>-developer`, base registrada, idempotencia,
reintento explícito `--task`, contexto de fallos/rework, cascada y `review_ref`.
El ciclo sigue siendo **READY → REVIEW → QA → DONE**, con Reviewer cruzado y
`feature qa` explícitos. El rol `qa` de ejecución sigue siendo de solo lectura;
es distinto del autor de tests.
El worker rechaza `qa-author` fuera de `feature develop`, para exigir siempre
el contexto validado y las guardias de zonas de Developer.

La guardia exige simultáneamente las `changeZones`/`testZones` declaradas y las
raíces cerradas `e2e/`, `server/__tests__/`, `webview-ui/test/`. Admite fixtures y
helpers dentro de esas raíces y zonas. Ni siquiera una zona amplia autoriza
cambiar producto, ni se aplican los espejos/co-ubicaciones de Developer al autor.
Un cambio fuera de ellas produce `change_zones_exceeded`. No añadir/ajustar un
test ejecutable produce `missing_test`, visible en `last_developer_failure` y en
el contexto del siguiente reintento. Los helpers solos no satisfacen ese requisito.

Antes de verificar, Developer y QA author aplican `eslint --fix --no-cache` y
`prettier --write --ignore-unknown` solo a los ficheros tocados, tras validar las
zonas y la integridad. Las correcciones forman parte del commit del runtime.
Los comandos usan la raíz del checkout y su configuración/ignore de estilo;
Prettier normaliza también CRLF introducido por escrituras del agente en Windows.
Después ejecutan `prettier --check --ignore-unknown` y
`eslint --no-cache` sobre los archivos tocados existentes (ESLint sobre JS/TS),
también con cascada o verificadores del Operator. Un fallo impide REVIEW.
Los tests Vitest escritos se ejecutan por fichero con el runner neutral aislado;
se conservan las comprobaciones de aserciones y de integridad.

Para Vitest del workspace `server`, si el checkout contiene `esbuild.js` (como
SoftwareAgents), el runner copia el árbol a un snapshot en scratch, excluye `.git`,
`node_modules`, `dist` y el scratch local, enlaza dependencias existentes y ejecuta
`node esbuild.js` antes de Vitest. Así se construyen también los hooks que requieren
los tests, incluso cuando los importan indirectamente. Nunca instala dependencias.
La copia, el build, HOME y las cachés quedan fuera del árbol aprobado; antes de
limpiar se valida y desenlaza la junction. Sin cierre confirmado se retiene scratch.
El diagnóstico de infraestructura queda en la tarea sin liberar su lease; SA-026
debe confirmar el cierre antes de recuperarla, conservando los intentos. Esa
recuperación detiene el run y requiere una nueva reanudación explícita.
Un fallo de preparación/build es infraestructura (`not_tested` en QA), nunca un
fallo de aserción. Repositorios fuente sin esa entrada de build y el workspace
webview conservan el perfil neutral sin build. El coste es una copia completa y
un build por invocación server, incluidos `related`, dentro del mismo deadline
compartido con Vitest; no se reutilizan artefactos entre referencias aprobadas.

Un fallo exclusivamente de Prettier/ESLint recibe un único reintento en el mismo
nivel; si persiste se detiene sin escalar. Los fallos de tipos/tests permiten la
cascada. Cada siguiente intento recibe `task.verifierFailures` como datos JSON no
confiables: comando, ficheros y primeras 32 líneas (máximo 4000 caracteres) por
fallo, saneados y con secretos redactados. La salida no se guarda en auditoría ni
telemetría; el motivo persistido identifica `verifier_failed: prettier|eslint|tsc|tests|e2e`
con los verificadores que fallaron.

Para e2e, el runtime deriva el spec concreto del diff/zonas. En specs de
`e2e/tests/standalone/`, usa Playwright directamente, equivalente a
`npm run e2e -- e2e/tests/standalone/audit.spec.ts --workers=1`, con configuración
neutral, `testMatch` exacto, un worker, sin retries ni global setup/reporters del
repositorio. Copia el checkout a scratch, enlaza solo dependencias existentes,
construye CLI (`node esbuild.js`) y webview (`vite build`) allí y usa Chromium ya
cacheado. No instala ni descarga nada. HOME/USERPROFILE/TEMP, build e informes
quedan aislados, con el mismo límite de tiempo/salida y terminación de árbol que
Vitest. Electron/VS Code requiere QA del operador y queda `not_tested` en runtime.
Un spec que termina en verde sin ejecutar ningún paso `expect` falla el verificador.

Si faltan Playwright, Chromium o entradas de build, falla la preparación o no hay
evidencia completa, devuelve `not_tested` con motivo. Eso permite entregar la
autoría a REVIEW, pero QA conserva **QA**, sin consumir reworks ni permitir DONE:
el informe incluye el comando y el motivo, y nunca convierte esa omisión en pass.
La evidencia de comando admite `result: not_tested` con `reason` del runtime.
Los fallos de tests ejecutados sí bloquean el verificador del autor. Los comandos
de QA siguen siendo IDs del runtime, nunca argv propuesto por el agente.

Antes de escribir e2e es normativo leer [Mocking model & rules](../e2e/README.md#mocking-model--rules):
frontera de proceso, scenario builder/mock-claude, JSONL append-only y aserciones
visibles; POST directo de hooks solo para standalone. Al añadir specs se regenera
el inventario. El autor debe documentar si el test falla sobre la base y su motivo
si no es razonable comprobarlo: una tarea de cobertura posterior puede tener ya
la feature en su base; no se retira producto para fabricar un fallo.

Prueba real de **FEAT-001-T05**, por Claude desde el checkout principal con build
actualizado y dependencias T01–T04 ya integradas/reconciliadas:

```powershell
node esbuild.js
node dist/cli.js feature develop FEAT-001 --task FEAT-001-T05
node dist/cli.js feature review FEAT-001 --task FEAT-001-T05
node dist/cli.js feature qa FEAT-001 --task FEAT-001-T05
node dist/cli.js feature show FEAT-001 --json
```

Si el runtime no pudo ejecutar el spec, Claude valida desde un checkout construido:
`npm run e2e -- e2e/tests/standalone/audit.spec.ts --workers=1`.
Esa ejecución manual es evidencia para revisión humana; no convierte por sí sola
un `not_tested` persistido en DONE. Esta implementación se prueba con CLIs falsas;
la prueba real y la integración corresponden a Claude.

## Orquestador secuencial y reanudable (SA-046)

Desde el checkout principal del Managed Project en Windows, con build y Operator
config preparados:

```powershell
node esbuild.js
node dist/cli.js feature run FEAT-001 --json
node dist/cli.js feature show FEAT-001 --json
```

Equivalente instalado: `pixel-agents feature run FEAT-001`. Si falta el spec,
añadir `--request docs/examples/FEAT-001-request.md`; sin esa opción se busca
`<brain>/features/requests/FEAT-001.md`. El request queda fijado en WorkStore y
no hace falta repetirlo al continuar. Si ya hay spec aprobado, no hace falta request.

El bucle no usa un LLM para decidir. Lee Feature, diseño y Tasks del WorkStore e
invoca los mismos pasos `spec`, `design`, `develop`, `review`, `qa` y la función de
`rebase`. Requirements propone el spec y se detiene para aprobación humana;
Architect importa el DAG. Selecciona secuencialmente por key entre las tareas que
cumplen `canStart`, y exige además que sus dependencias DONE estén integradas.
Developer enruta `qa`/`test`/`qa-author` al autor de tests existente. Una revisión
`request_changes` o QA con defectos vuelve al desarrollo con el contexto persistido.
Los reintentos de Developer usan únicamente `tasks.attempt`/`max_attempts` del
WorkStore; Reviewer y QA conservan su límite compartido de informes negativos
válidos. Requirements/Architect derivan sus fallos del historial de transiciones
de la tarea desde el último reset explícito a READY. No hay otro presupuesto en
`feature_runs.state`: los contadores antiguos se descartan al reanudar, por lo que
un reset o cambio de base no deja intentos fantasma. Las esperas sin Execution,
los fallos de infraestructura del verificador (build, entorno, timeout) y QA
`not_tested` no gastan intentos del agente. Detienen el run con exit 3 y diagnóstico;
se reanudan explícitamente una vez resuelto el entorno. `FAILED_FINAL`, cancelación, bloqueo y topes
detienen el run con exit 1 y diagnóstico. No replanifica ni ejecuta en paralelo.

### Rama de integración y base de tareas

El runtime crea `sa/FEAT-001-integration` desde el tip **local** de `main`, sin
fetch, checkout ni modificación de main. Cada Task DONE se publica allí mediante
fast-forward verificado. Si una tarea completada previamente tiene historia
divergente, prepara un merge con `git merge-tree --write-tree` y un commit de dos
padres; un conflicto impide mover la ref. Nunca ejecuta hooks ni instala paquetes.
La rama de integración debe estar libre de checkouts y sus movimientos externos
requieren reconciliación: el runtime no los adopta silenciosamente.

Las tareas nuevas parten del HEAD integrado en ese momento. Developer, Reviewer,
QA, publicación de rama y `feature rebase` consultan esa base runtime del WorkStore,
en lugar de `project.repo.defaultBranch`. `task-bases` registra el SHA exacto y
`review_ref.base` conserva esa referencia. Si la base avanzó durante REVIEW/QA,
el run invoca el rebase existente: patch-id idéntico mantiene las aprobaciones;
un patch diferente vuelve a REVIEW. Un conflicto detiene el run conservando evidencia.

Antes de admitir trabajo y de finalizar se compara `main` con la base persistida
de integración. Un avance se verifica con `merge-tree` y se publica mediante un
intent recuperable; REVIEW/QA se rebasan después sobre esa integración. Un conflicto
abre un gate humano. Cada lanzamiento, incluidos reintentos de Developer/QA author,
exige que los SHA aprobados de las dependencias DONE sean ancestros del HEAD real;
una rama antigua que no los incluya se bloquea para reconciliación humana.
Las publicaciones rechazan refs simbólicas, usan CAS con `update-ref --no-deref`
y comprueban que `main` conserve su SHA tras cada movimiento.

Tras integrar todas las tareas del DAG, `features.status=ready_to_merge` y el
resumen indica rama y SHA. El merge de esa rama a main sigue siendo humano, tras
revisión cruzada y QA real de Claude. No hay push de la rama de integración.
La publicación opcional de ramas Developer sigue su política externa existente.
El run conserva la obligación y la política de push junto al `review_ref` antes
de avanzar. Fija la política antes de lanzar Developer y la conserva al recuperar
su resultado, aunque cambie la configuración del Operator. Recupera también los
resultados de worker sin push confirmado. Un
push fallido o incierto detiene el run; su clave de idempotencia PENDING exige
reconciliación y nunca se interpreta como publicación completada.

### Gates, estado y recuperación

`pixel-agents task retry <KEY> --reason <texto>` exige ingreso humano (SA-003),
sin excepción de autopilot. Primero reutiliza `task backup` y después aplica un
reset atómico con control de versión. Admite WAITING_HUMAN, FAILED_FINAL,
FAILED_RETRYABLE y QA de una Feature; rechaza DONE, leases y recuperaciones
pendientes. Las decisiones humanas abiertas deben resolverse antes del retry.
Con `review_ref` vuelve a READY y lo limpia para rework del Developer; sin él,
queda FAILED_RETRYABLE. Conserva informes, reinicia `attempt` a cero y guarda el
motivo en `blocked_reason` y en el contexto del siguiente Developer. La auditoría
`manual_retry` identifica al operador humano, motivo y backup. No reinicia el
límite compartido de rondas de rework.

Si la selección QA no contiene tests ejecutables o incluye un test fuera de las
raíces admitidas (salvo `testZones` explícitas), el runtime genera un TestReport
`fail` con la causa y la ruta, sin lanzar al agente. Reutiliza la Execution QA
ya registrada durante la preparación y confirma su cierre sin proceso; después
usa `completeQa`, artefacto y auditoría habituales. Esto conserva los invariantes,
la identidad existente de los defectos y el límite de rondas: vuelve a READY sin
`review_ref`, o escala al alcanzar el tope. No representa fallos de infraestructura.
Un avance posterior a READY/FAILED_RETRYABLE deja de proyectar un fallo histórico
de Reviewer/QA como bloqueo actual; el historial permanece intacto.

Una decisión abierta o expirada, `WAITING_HUMAN`, la aprobación pendiente del spec
o un QA `not_tested` detienen el bucle con exit 3. El mensaje identifica qué falta,
remite a `feature show` y da `pixel-agents feature run FEAT-001` para continuar.
Las respuestas de Requirements/Architect se incorporan mediante sus comandos
`--answers` existentes, y la aprobación sigue requiriendo `feature approve`.
El orquestador nunca responde una decisión ni aprueba. `WAITING_QUOTA` también sale
con 3; relanzar el mismo run reevalúa el gate de cuota y selección.

WorkStore v14 añade la identidad de creación del runner a `feature_runs`;
v13 incorporó `feature_runs` y `worker_publications`. Actualizar y
reiniciar coordinadamente los escritores antes de migrar, como en
[task CLI](task-cli.md#migraciones-de-la-base-compartida). Guarda progreso,
intentos, acción activa, rama/HEAD integrado y publicaciones preparadas. Un lock
SQLite por Project/Feature rechaza un segundo run con el mismo PID e identidad
de creación SA-026. Solo un proceso ausente o una identidad distinta permite
recuperar el lock. Identidad ausente o incierta exige reconciliación humana;
no se roba a un runner vivo por antigüedad.

Después de matar el proceso, relanzar el mismo comando espera las leases vigentes
y usa SA-026 para recuperar las caducadas, verificando el cierre de Executions.
No duplica ramas ni resultados ya registrados. Los commits preparados y los
artefactos validados de Requirements/Architect tienen un intent persistente antes
de escribir/publicar; se completan sin otra propuesta del agente. El registro
previo de la actualización de la rama de integración permite reconocer tanto el
SHA anterior como el ya publicado. Un journal de rebase se reconcilia solo contra
sus dos estados conocidos y WorkStore; cambios ajenos conservan el bloqueo.
Git, SQLite y filesystem siguen sin transacción distribuida: una identidad de
proceso no verificable, edición ajena o estado que no coincide exige intervención
humana. Nunca se interpreta esa incertidumbre como éxito.

Cada acción produce líneas `acción tarea: resultado` y auditoría `feature_run`;
el worker conserva sus eventos e informes existentes. Con `--json`, el progreso
va a stderr y stdout contiene únicamente el resumen final, con estado, Tasks,
rama/SHA de integración, mensaje, comando de continuación y código de salida.
`feature show --json` incluye `orchestrator` con el checkpoint persistido.

### Configuración del Operator e ingreso

En `~/.pixel-agents/config.json`, bajo `projects.<project-id>`:

```json
"orchestrator": { "maxConcurrentTasks": 1 }
```

El valor por defecto es 1. Cualquier valor mayor falla antes de ejecutar y remite
a SA-037. El repositorio y el DAG no conceden concurrencia ni autoridad.

Los mismos marcadores de ingreso gestionado/agente/autopilot que bloquean
`approve` bloquean `run`. La excepción opcional para la oficina es la allowlist
SA-003 `companyAutopilot[<checkout-absoluto>].command`: debe coincidir **todo el argv
real**, incluido ejecutable, launcher y `feature run FEAT-001` con sus opciones.
Por ejemplo `["C:/Program Files/nodejs/node.exe", "D:/project/dist/cli.js", "feature", "run", "FEAT-001", "--json"]`,
usando las rutas efectivas del operador. No hay flags de actor ni comodines. La
autorización de run permite su mantenimiento/rebase dentro de este ciclo; no
permite `approve`, respuestas ni merge a main. El board no puede ampliar ese argv.

La batería automatizada usa únicamente CLIs falsas y repositorios/perfiles
aislados; incluye tres tareas encadenadas, gates, rework, exclusión y recuperación.
La prueba que mata el runner en RUNNING requiere el helper Windows de SA-026.
Si el sandbox deniega CIM, usar `SA_SKIP_TASKKILL_TEST=1` y repetir esa prueba fuera
del sandbox antes de integrar. No acredita QA real con cuentas autenticadas.

## Próximos pasos

| Paso                 | Estado y contrato pendiente                                                     |
| -------------------- | ------------------------------------------------------------------------------- |
| Requirements Analyst | SA-041: petición → FeatureSpec validado → aprobación humana                     |
| Architect            | SA-042: FeatureSpec aprobado → TechnicalDesign y TaskDAG validados e importados |
| Developer            | SA-043: una tarea READY → rama y commits con tests y `review_ref`               |
| Reviewer             | SA-044: ReviewReport persistido, executor cruzado y rework acotado              |
| QA                   | SA-045: TestReport, defectos trazables, DONE y dependientes READY               |

El importador [task CLI](task-cli.md) usa `features/<FEAT-ID>.yaml` si existe;
mantiene `features/requests/` como alternativa para documentos históricos.

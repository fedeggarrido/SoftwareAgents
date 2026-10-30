# Leases y efectos idempotentes de WorkStore

SA-026 amplía el WorkStore de [ADR-0003](adr/0003-workstore-sqlite-local.md).
SA-QA-1 añade fencing de recuperación y la migración v4. Se activa al abrir
explícitamente un WorkStore del Managed Project desde el servidor standalone.
No migra claims legacy ni conecta el ledger JSONL de los Executors con SQLite;
los consumidores deben registrar aquí sus Executions. La oficina legacy sigue
usando sus fuentes actuales.

## Reserva y renovación

`claim(taskId, owner, ttl)` recibe milisegundos; el TTL predeterminado es **60 segundos**.
El worker debe usar un owner único por instancia, renovar con `heartbeat` cada
**20 segundos** y dejar de trabajar si pierde la lease. Cada heartbeat recibe su
TTL; si se omite, vuelve a usar 60 segundos. Se usan timestamps UTC del mismo
Host. Un salto del reloj hacia delante puede adelantar la caducidad; uno hacia
atrás puede retrasarla o acortar una renovación. No hay reloj monotónico
persistente ni coordinación entre Hosts. Los tests cubren ambos saltos y el token
impide renovar durante una recuperación incluso con un reloj atrasado en otro proceso.
Antes de reservar un token, un salto hacia atrás puede hacer que una lease parezca
vigente otra vez: no se garantiza caducidad monotónica.

Un claim acepta QUEUED, READY o FAILED_RETRYABLE. Recorre las transiciones legales
hasta LEASED bajo una adquisición excluyente, comprobando dependencias y versión.
La lease y sus DomainEvents se confirman juntos. Solo gana un claimant.
El consumidor pasa de LEASED a RUNNING con `transition` y la versión retornada.
Para rework se usa **`claimRework(taskId, expectedVersion, owner, ttl)`**: adquiere
atómicamente una lease nueva al pasar de REVIEW/QA a RUNNING e incrementa attempt.
`transition` rechaza esos reworks y la entrada directa a LEASED. `createTask`
rechaza estados activos o leases importadas. Los triggers SQLite v4 también
impiden nuevos registros LEASED/RUNNING con lease incompleta o fecha inválida.
Los registros históricos activos sin lease no se reescriben durante la migración:
se consideran candidatos de recuperación; con Executions inseguras quedan bloqueados.

El heartbeat no cambia la versión de la Task, para conservar el fencing de la
Execution. Renovación y release comprueban owner, estado y caducidad bajo el lock.
`transition` y `createExecution` rechazan leases vencidas y reservas de recuperación.
**`createExecution` ahora devuelve Promise<void> y debe esperarse con await**:
la consulta de identidad al SO es asíncrona y la inserción SQL vuelve a comprobar
versión, owner, vencimiento y ausencia de token en una sola sentencia bajo el lock.
Si falla el registro después de lanzar el CLI, el consumidor debe detenerlo;
SQLite no contiene procesos lanzados sin registrarlos. Para cerrar también esa
ventana se necesita coordinar la reserva con el Executor antes de que pueda escribir.

`release` reserva la recuperación y termina las Executions antes de pasar a
FAILED_RETRYABLE o FAILED_FINAL. Una salida normal RUNNING → REVIEW elimina la
lease, pero por sí sola **no acredita** que el árbol del CLI terminó.

## Recuperación excluyente por tarea

Cada handle abierto tiene un sweeper cada **5 segundos**, con timer unref que se
cancela en close. Cada claim recupera solo la Task solicitada; no espera el barrido
ni la terminación de Tasks independientes. El sweeper consulta candidatos activos
vencidos/incompletos y procesa cada Task por separado, con sus errores aislados.
`recoverExpiredLeases` devuelve las Tasks recuperadas; los fallos se registran en
consola y persisten en **`listLeaseRecoveries()`**, delimitados por Project.

Antes de tocar el SO, una transacción corta BEGIN IMMEDIATE relee el estado y
vencimiento actuales y reserva un **token UUID persistente**, único por Task.
Esto protege también contra un candidato antiguo cuya misma lease fue renovada.
El token excluye heartbeat, transición, otro claim/rework/release y registro de
Executions. El cierre comprueba **el mismo token y versión**. La terminación y la
consulta de identidad ocurren fuera del lock y de forma asíncrona; otras Tasks
pueden seguir renovando y reclamándose durante un helper lento. Solo se consultan
Executions de la Task y de generaciones anteriores, mediante un índice específico.

La transición final, incremento de attempt, DomainEvent y eliminación del token
se confirman juntos. Si attempt + 1 alcanza max_attempts, termina en FAILED_FINAL;
antes pasa a FAILED_RETRYABLE. Las referencias Git y los cambios se conservan.

Si falla el helper o el cierre SQL, **se conserva el token y su error**. Si muere el
proceso recuperador, el token sin error sigue visible tras reabrir. No tiene TTL
ni se roba automáticamente: el recuperador antiguo podría seguir usando handles.
La Task insegura queda reservada; Tasks independientes siguen funcionando.
Cerrar un handle del store durante una recuperación tampoco libera su token.
Un fallo anterior a obtener el token se registra en consola; no se puede garantizar
persistir su diagnóstico si SQLite no permite escribir.

La reconciliación requiere detener y comprobar el recuperador anterior y todos
los posibles escritores, inspeccionar el trabajo parcial y reparar explícitamente
el registro con evidencia del Operator. Eliminar solo el token no basta si una
Execution sigue sin prueba de cierre. No hay API/UI de reconciliación ni prueba
de cierre aportada automáticamente por el Executor legacy en este slice; se
propone conectarlo a contención de procesos y Human Decisions en un cambio posterior.
Un registro de Human Decision por sí solo no concede autoridad de ejecución.

## Executor y worktree huérfanos

`pid` debe identificar la **raíz del CLI**, no el worker que lo lanzó.
`pid_started_at` conserva los ticks UTC exactos de creación del proceso Windows,
separados del timestamp lógico `started_at`. El registro de una Execution activa
captura su identidad con Get-Process.StartTime. Nunca se compara una hora aproximada
con una tolerancia capaz de confundir un PID reciclado.

Para recuperar en Windows, un helper C# embebido y compilado con Add-Type abre
un handle nativo con OpenProcess. GetProcessTimes verifica la identidad y
TerminateProcess/WaitForSingleObject operan sobre **ese mismo handle retenido**;
no se vuelve a abrir por PID para matar y no se usa taskkill. Este helper evita
depender de que Process.Kill reutilice el handle consultado en una versión concreta
de .NET. Cada descendiente capturado también conserva su handle. Las consultas CIM
se limitan a ParentProcessId de procesos ya fijados y validan CreationDate
(microsegundos) contra la creación del handle. No se terminan procesos ajenos
al árbol registrado; Fundtrinsic queda fuera del alcance.

Raíz ausente, ya terminada o con PID reutilizado **sin prueba persistida de cierre**,
identidad ilegible, descendiente desaparecido/reciclado durante la captura,
permiso denegado y timeout bloquean la reutilización. El error y token quedan
visibles. Al terminar y esperar la raíz y los descendientes capturados se guarda
`tree_closed_at` por Execution bajo el mismo token. El siguiente claim omite esas
Executions ya cerradas y nunca vuelve a matar sus PIDs, aunque se hayan reutilizado.
Los consumidores no pueden importar ese campo mediante createExecution.

**Executors SA-093:** el supervisor registrado no lanza el CLI hasta recibir el
ACK de registro duradero. En Windows, antes del lanzamiento, un helper PowerShell
fijo compila mediante Add-Type el pequeño wrapper kernel32 incluido en el bundle,
crea un Job con KILL_ON_JOB_CLOSE (sin BREAKAWAY ni SILENT_BREAKAWAY) y asigna el
supervisor. Solo entonces confirma JOB_READY y el supervisor crea el CLI, que
hereda el Job junto con todos sus descendientes. No hace falta lanzar código del
modelo suspendido: el único código que corre antes de la asignación es el
supervisor fijo, que todavía no ha creado el CLI. Si falla la asignación, no lanza.

El helper conserva el único handle propietario, fuera del Job, y observa el
handle retenido del supervisor. Su muerte o el cierre del supervisor cierra el
Job y mata sus miembros. El nombre local deriva del PID y los ticks exactos de
creación. Recuperación verifica primero la identidad de la raíz, abre el Job y
lo termina, esperando ActiveProcesses=0 antes de acreditar TREE_CLOSED. No necesita
CIM para estos procesos. Cancelación usa IPC al supervisor, que pide terminar el
Job; nunca vuelve a abrir su PID. Una salida normal solo pide persistir el cierre
cuando el Job contiene únicamente al supervisor; descendientes todavía vivos
retienen la Execution hasta salir o hasta cancelación/timeout.

Se elige código embebido y compilación por lanzamiento, sin caché escribible ni
dependencias: evita sustitución de scripts/DLL cacheados y funciona también en
el bundle. Se invoca WindowsPowerShell desde SystemRoot/System32, sin perfil,
con comando fijo codificado y solo el PID generado por el runtime en el entorno.
No recibe prompts, comandos ni rutas del modelo y no eleva permisos. Un fallo de
registro mata el supervisor antes de cualquier CLI; el ledger también cancela
el handle si falla su registro inicial. Los registros históricos sin Job siguen
usando el helper de captura anterior y conservan su limitación residual.

En Linux/macOS el lanzamiento usa un process group separado y la cancelación
envía SIGKILL al grupo. Eso no impide setsid/escape de código adversarial. La
recuperación persistida por identidad de WorkStore sigue requiriendo Windows y
falla cerrada en esos SO: este cambio no inventa una identidad portable segura.

**Límite residual de Executions históricas sin Job:** tree_closed_at acredita el cierre del **árbol capturado**, no
contención del SO. CIM no puede probar que un descendiente no escapó o nació después
de capturar su padre y antes de terminarlo. La identidad segura del handle resuelve
la carrera de PID reciclado; no resuelve esa carrera de creación/escape. Para
excluir cualquier escritor adversarial hace falta lanzar el Executor dentro de un
**Windows Job Object** (sin breakaway y con asignación antes de permitir ejecución),
o un mecanismo equivalente, como el lanzamiento de Executors SA-093 descrito arriba.
Un CLI histórico ya terminado sin tree_closed_at, incluso
tras una finalización normal, requiere reconciliación antes del siguiente intento.
Los helpers tienen deadline asíncrono de 60 segundos y espera por handle de 10;
SQLite conserva operaciones síncronas cortas y su propio busy_timeout: contención
SQL prolongada aún puede retrasar el event loop. La recuperación de Executions con
PID en otros SO falla explícitamente hasta contar con un mecanismo equivalente.

El worktree, la rama y los cambios parciales **se conservan**. No se ejecutan reset,
clean ni eliminación automática. Los tests usan un worktree Git real, un archivo
modificado, uno sin seguimiento y una junction sintética, y comprueban su conservación.

## Idempotencia de efectos externos

El lock del orquestador de Feature usa `feature_runs.pid_started_at` (WorkStore
v14), consultado con `processStartIdentity` de SA-026. Un PID solo conserva la
propiedad si coincide su identidad exacta de creación. Un PID reutilizado o un
proceso confirmado ausente permite recuperar el lock; una consulta fallida o un
lock histórico sin identidad conserva el bloqueo y pide reconciliación humana.
La consulta al SO sucede fuera de SQLite y el claim vuelve a comprobar el registro
bajo el lock de escritura, para no robar una propiedad cambiada durante la consulta.
La reconciliación requiere comprobar el runner anterior y sus posibles escritores;
la edad del lock nunca demuestra su cierre.

`withIdempotency(key, fn)` reserva una clave persistente, única por Project, **antes**
de invocar el efecto. No mantiene un lock SQLite mientras ejecuta `fn`. Usar claves
estables que identifiquen operación, Task y artefacto (por ejemplo, el SHA para un
push); una clave distinta representa otro efecto. Esto no concede permisos para
push, PR o ClickUp: el consumidor debe aplicar sus gates antes de llamar.

Al terminar, guarda el resultado JSON de `fn` (también admite `undefined`) como
COMPLETED. Las llamadas posteriores devuelven ese resultado sin repetir el efecto,
incluso tras reiniciar el proceso. Los resultados deben ser datos JSON, sin ciclos,
BigInt ni objetos que dependan de prototipos.

Una llamada concurrente encuentra PENDING y falla. Si el proceso muere, `fn` lanza
un error, o no se puede serializar/persistir el resultado, la clave queda PENDING.
No se libera automáticamente: el sistema externo pudo haber realizado el efecto.
El Operator debe reconciliarlo y reparar explícitamente el registro antes de
reintentar. No se promete exactly-once entre SQLite y un servicio remoto; se evita
reinvocar automáticamente un efecto incierto. SA-026 no añade una UI de reconciliación.

## Verificación real pendiente de Claude

Ejecutar desde el worktree, sin SA_SKIP_TASKKILL_TEST:

```powershell
$env:TEMP="$PWD\.vitest-tmp"; $env:TMP=$env:TEMP
Remove-Item Env:SA_SKIP_TASKKILL_TEST -ErrorAction SilentlyContinue
npm exec --workspace server -- vitest run __tests__/leases.test.ts __tests__/leaseProcesses.test.ts __tests__/leaseOrphan.test.ts __tests__/processRecovery.test.ts __tests__/windowsProcessRecovery.test.ts __tests__/workstore.test.ts __tests__/agentRoles.test.ts
```

Para SA-093 añadir `__tests__/windowsJob.test.ts` y
`__tests__/registeredProcess.test.ts`: nieto creado después de retener los handles
de recuperación, cancelación por Job, rechazo asíncrono del registro y N1
ACCESS_DENIED con salida/timeout/error secundario. Repetir sin
SA_SKIP_TASKKILL_TEST fuera del sandbox; no se invocan CLIs de IA reales.

La prueba de worker muerto mantiene raíz CLI y descendiente vivos. Tras el TTL,
el siguiente claim debe terminar ambos, guardar tree_closed_at, incrementar el
intento y conservar rama, worktree, cambios y junction. También se prueba una raíz
CLI que desapareció con un descendiente escribiendo: debe bloquear el claim y
mantener el error, owner y attempt anteriores. Son procesos/repos temporales
propios, sin CLIs autenticados ni escrituras al perfil real.

El sandbox de Codex denegó Get-CimInstance (Access denied) al probar el árbol vivo.
Se utiliza SA_SKIP_TASKKILL_TEST=1 únicamente para esa prueba; su nombre se conserva
por compatibilidad aunque ya no se use taskkill. Claude debe repetirla fuera del
sandbox sin esa variable. La prueba de raíz desaparecida y la prueba determinista
del helper C# sobre sustitución de PID sí pueden ejecutarse en el sandbox.

Los tests de procesos reales controlan dos peers Node por IPC y aíslan solo la
frontera del SO: claims concurrentes, snapshot antiguo tras heartbeat, exclusión
por token, registro asíncrono intercalado y recuperador muerto. La prueba C# ejecuta
el algoritmo de producción con una API kernel controlada que sustituye el mapa PID
entre consulta de identidad y terminación y verifica que solo se usa el handle antiguo.
Otra prueba ejecuta GetProcessTimes, TerminateProcess y WaitForSingleObject sobre
un proceso Windows fixture real, usando un único handle retenido, sin depender de CIM.

En la oficina real, confirmar que Characters y paneles legacy siguen mostrando
actividad normal. Las leases SQLite no se conectan todavía al worker legacy ni
se muestran en un panel nuevo. Para el ajuste visual LOW, un brief explícito
**Rol: QA / Role: Reviewer / Actúa como QA / Actúa como Reviewer**, metadata
`agent_role` reconocida o un rol equivalente en registry debe etiquetar Calidad,
incluso desde el checkout principal. Mencionar QA/Reviewer como parte del trabajo
sin asignar ese rol conserva la etiqueta anterior: no se infiere por actividad.

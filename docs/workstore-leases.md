# Leases y efectos idempotentes de WorkStore

SA-026 amplía el WorkStore de [ADR-0003](adr/0003-workstore-sqlite-local.md).
Se activa al abrir explícitamente un WorkStore del Managed Project desde el
servidor standalone. No migra claims legacy ni conecta el ledger JSONL de los
Executors con SQLite; los consumidores del nuevo WorkStore deben registrar sus
Executions aquí. La oficina legacy sigue usando sus fuentes actuales.

## Reserva y renovación

`claim(taskId, owner, ttl)` recibe milisegundos; el TTL por defecto es **60 segundos**.
El worker debe usar un owner único por instancia (por ejemplo, un UUID), renovar
con `heartbeat` cada **20 segundos** y dejar de trabajar si pierde la lease.
Cada heartbeat recibe su TTL; si se omite, vuelve a usar 60 segundos.
Se usan timestamps UTC y el reloj del mismo Host: un salto de reloj puede adelantar
o retrasar la recuperación. No se admite coordinación entre Hosts.

Un claim acepta QUEUED, READY o FAILED_RETRYABLE. Recorre las transiciones legales
de SA-025 hasta LEASED en una sola transacción, comprobando dependencias y versión.
Solo gana un claimant; el perdedor recibe un error, sin eventos parciales.
El consumidor pasa a RUNNING con `transition` y la versión retornada. El heartbeat
no cambia esa versión, para no invalidar el fencing de la Execution. La renovación
y release comprueban owner, estado activo y caducidad bajo el lock de escritura.
`transition` y `createExecution` rechazan una lease vencida; registrar una Execution
activa exige la versión actual de la Task.

`release` aborta el intento: termina el executor registrado y pasa a FAILED_RETRYABLE,
o FAILED_FINAL al agotar intentos. Una finalización normal se registra con
RUNNING → REVIEW; salir de LEASED/RUNNING elimina los campos de lease.

Cada handle del WorkStore tiene un sweeper de **5 segundos**, con timer `unref` que
se cancela en `close`. También se barre al inicio de cada claim. Servidor y workers
pueden barrer concurrentemente: la versión se vuelve a comprobar bajo `BEGIN IMMEDIATE`
y `retryBusy`; la recuperación efectiva y su DomainEvent se confirman juntos una
sola vez. El servidor debe mantener abierto el handle mientras coordine el Project.

Una lease vencida incrementa `attempt` en uno. Cuando el nuevo contador alcanza
`max_attempts`, pasa a FAILED_FINAL; antes pasa a FAILED_RETRYABLE. Por ejemplo,
con `attempt=0` y `max_attempts=3`, la tercera recuperación es definitiva.

## Executor y worktree huérfanos

Caducar no prueba que el Developer ni su CLI hayan muerto. Antes de recuperar o
reasignar se comprueban las Executions registradas de esa Task, incluidas las
anteriores. `pid` debe identificar la **raíz del CLI executor**, no el worker que
lo lanzó: si muere el worker, el CLI sigue siendo localizable.

`started_at` conserva el timestamp lógico de la Execution. La migración v3 añade
`pid_started_at`: identidad exacta de creación del proceso del SO, expresada como
ticks UTC de `Get-Process.StartTime`. `createExecution` la captura automáticamente
para una Task con lease activa. No se compara una hora aproximada del evento CLI
con una tolerancia que pudiera confundir un PID reutilizado.

En Windows se consulta únicamente el PID registrado. Si ya murió, no se mata nada;
si su identidad cambió, se deja vivo el proceso que reutilizó ese PID. Si coincide,
se ejecuta `taskkill.exe /PID <pid> /T /F` y se verifica que la raíz original haya
desaparecido. Errores de permisos, timeout, identidad ilegible o una Execution
legacy viva sin identidad bloquean la recuperación y el claim. Se mantiene el
estado anterior y el sweeper informa del error. Se intentan recuperar las otras
Tasks del Project, pero el claim recibe el fallo del barrido para que sea visible.

Las consultas y terminación del SO ocurren **fuera de la transacción SQLite**;
después se comprueban otra vez versión y caducidad. Actualmente son síncronas,
con timeout de 10 segundos por comando; pueden bloquear el hilo del llamador.
No se recorren procesos del Host ni se interviene en Fundtrinsic. La recuperación
de executors vivos en otros sistemas operativos falla explícitamente hasta contar
con un mecanismo equivalente.

El worktree, la rama y los cambios sin commit **se conservan**. No se ejecuta reset,
clean ni eliminación automática; el siguiente intento recibe las referencias
existentes y debe inspeccionar el trabajo parcial antes de continuar.

Límites del MVP: la comprobación de identidad y `taskkill` son dos operaciones del
SO; queda una ventana pequeña de reutilización entre ambas. `/T` cubre el árbol
que Windows identifica bajo la raíz viva; no acredita recuperar descendientes
que escaparon de ese árbol o cuya raíz CLI ya desapareció. Un Job Object o un
registro completo de descendientes requiere coordinación con los Executors y
queda fuera de SA-026. El caso cubierto es worker muerto con raíz CLI viva.

## Idempotencia de efectos externos

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

Ejecutar desde `server`, sin `SA_SKIP_TASKKILL_TEST`:

```powershell
$env:TEMP="$PWD\..\.vitest-tmp"; $env:TMP=$env:TEMP
npx vitest run __tests__/leaseOrphan.test.ts
```

La prueba lanza un worker y un CLI fixture con descendiente, registra la identidad
del CLI, mata únicamente el worker y comprueba que el CLI sigue vivo. El claim tras
el TTL debe matar CLI y descendiente antes de reservar al siguiente owner, incrementar
el intento y conservar el worktree. En un sandbox que deniegue `taskkill`, usar
`SA_SKIP_TASKKILL_TEST=1` y registrar que este criterio sigue pendiente fuera del sandbox.
La prueba utiliza repos y procesos temporales propios, sin CLIs autenticados ni perfil
real. En la oficina real, confirmar además que los Characters y paneles legacy siguen
mostrando actividad normal; esta tarea no añade indicadores visuales de leases.

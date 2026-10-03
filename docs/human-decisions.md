# Human Decisions y leases

SA-028 conserva las reglas de leases y recuperación de SA-026/SA-QA-1.
La migración de los paquetes de escalado es la **v5**; no modifica los triggers
de tareas activas ni las reservas de recuperación de v4.

## Pausa y respuesta

Abrir una decisión comprueba todos sus bloques en una transacción corta. Las
tareas LEASED/RUNNING deben tener una lease vigente; una lease vencida o incompleta
debe pasar primero por la recuperación normal, con su incremento de intento.
Se reservan tokens persistentes para **todos** los bloques antes de tocar el SO.
Estos tokens excluyen renovaciones, transiciones, claims y registros de Executions,
también desde otro handle del WorkStore.

Fuera del lock SQLite se cierran las Executions registradas de esas generaciones
mediante el mismo mecanismo de recuperación segura y se persiste `tree_closed_at`.
Después, una única transacción comprueba cada token y versión, pasa todos los
bloques a WAITING_HUMAN, elimina sus leases, registra los DomainEvents y el paquete
de escalado con sus estados anteriores y elimina las reservas. Esta pausa no es
un fallo: no incrementa `attempt` y conserva referencias Git y `blocked_reason`.

Una respuesta humana válida devuelve las tareas antes LEASED/RUNNING a **READY**,
sin lease. Las demás recuperan su estado anterior. No se restaura el owner antiguo
ni se adquiere una lease en nombre de quien responde. El siguiente consumidor debe
hacer `claim` con un owner explícito y volver a comprobar las dependencias; una
Execution nueva requiere registro nuevo. No se ejecuta automáticamente la acción
escalada, tampoco al elegir la opción recomendada.

La respuesta, `answeredBy`, timestamp, restauraciones y eventos se confirman en una
transacción que exige persistir una **intención `pending`** en el JSONL antes del
commit. Solo después de confirmar SQLite se escribe `answered`; ambos registros
comparten `attemptId` en `outcome.detail`, junto con el actor y el indicador
`reconcile`. Un fallo de la intención revierte SQLite. Un fallo del COMMIT deja
`pending` y un rechazo, nunca un éxito. Si falla la confirmación JSONL después del
COMMIT, o el proceso cae en esa ventana, la intención sigue pendiente: consultar
la decisión persistida en WorkStore antes de reintentar. El servicio informa
explícitamente de la respuesta ya confirmada si falla ese segundo append; no
registra un rechazo de una respuesta que ya se confirmó. Esta alternativa no es
una outbox ni garantiza exportación automática de confirmaciones pendientes.

Responder o expirar comprueba que ningún bloque tenga una reserva de recuperación:
una respuesta no elimina ni elude tokens. Responder o reconciliar comprueba además,
dentro de la transacción, que ninguna Execution con PID esté pendiente de cierre,
incluidas generaciones antiguas. Registrar una Execution con PID requiere una lease
vigente LEASED/RUNNING; se captura la identidad fuera del lock y se vuelve a comprobar
la lease, versión, owner y reservas dentro de la transacción. Los registros con
`pid: null` son metadatos sin proceso operativo y conservan su compatibilidad.

Expirar conserva WAITING_HUMAN y no registra una respuesta humana. Los gates `open`
y `expired` impiden transiciones y claims ordinarios. La salida de uno expirado
exige `HumanDecisions.reconcile(id, answer, privileged, answeredBy, level)` desde
un ingreso confiable: comprueba privilegio autenticado y política, exige una opción
válida y registra intención/confirmación con `reconcile: true`. WorkStore realiza
la restauración atómica y un DomainEvent con motivo de reconciliación explícito.
No se expone una reconciliación implícita en la respuesta ordinaria ni un mensaje
nuevo de UI; una segunda respuesta ordinaria a una decisión expirada se rechaza.

El HUD mínimo en modo proyecto muestra `Decisiones (N)` cuando hay decisiones,
aunque no exista board legacy. Abre el mismo DecisionsPanel y usa el mismo mensaje
de respuesta, cuya autoridad sigue dependiendo del token autenticado del servidor.

## Fallos y límites

Una validación fallida antes de reservar no cambia tareas, eventos ni decisiones y
no termina procesos. Si falla el cierre del árbol o la transacción final después
de reservar, se conservan **todos** los tokens y su error, sin publicar una decisión
parcial ni cambiar estados. Las pruebas de cierre ya persistidas se conservan:
los efectos del SO no se pueden revertir. Los tokens no expiran ni se roban; el
Operator debe reconciliarlos según [la recuperación de leases](workstore-leases.md).
Si el proceso muere durante la pausa, las reservas siguen visibles tras reiniciar.

Se mantienen los límites del mecanismo de cierre existente: solo conoce Executions
registradas, acredita el árbol capturado y no implementa contención del SO. Una
Execution con PID pero sin identidad o prueba de cierre verificable bloquea la pausa.
Los procesos que nunca se registraron no están contenidos por esta operación.

El worker supervisado legacy registra su tarea como REVIEW cuando escala cambios
protegidos después de que termine su CLI. No inventa una tarea RUNNING sin lease;
responder devuelve esa tarea a REVIEW para una revisión explícita. No conecta el
ledger JSONL legacy con las Executions SQLite ni concede autoridad de commit.

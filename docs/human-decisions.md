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
transacción que exige persistir la auditoría antes del commit. Un fallo de auditoría
revierte esos cambios SQLite. Responder o expirar una decisión comprueba que ningún
bloque tenga una reserva de recuperación: una respuesta no elimina ni elude tokens.
Expirar conserva WAITING_HUMAN y no registra una respuesta humana; cualquier salida
posterior requiere recuperación explícita del gate.

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

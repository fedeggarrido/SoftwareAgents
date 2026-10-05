# Selección y quota gate (SA-036, SA-QA-5)

`pixel-agents quota check --executor claude|codex --role <rol> [--json]`
devuelve 0 para `go` o `probe`, y 3 para `wait`. JSON incluye `reason` y,
en espera por cuota, `resetsAt` (epoch seconds; null si no se conoce).
El rol es informativo: no reserva porcentajes ni concede permisos.
`quota check` observa; el lanzamiento del worker vuelve a decidir y reserva un slot.

`worker run --task SA-### --brief <archivo> --select-executor` activa la selección
por capabilityClass del Developer. Sin ese flag se conserva la preferencia Claude,
pero se aplica igualmente el gate y la reserva. La primera preferencia permitida
se mantiene incluso si debe esperar; no hay fallback.

`.softwareagents/agents/model-policy.yaml` es un catálogo ordenado de preferencias
declarativas. Su parser rechaza campos de autoridad. La ruta permanece protegida
por SA-063. Solo `~/.pixel-agents/config.json → projects.<id>` autoriza executors,
`quotaThresholds` (porcentaje mínimo restante) y `concurrency.perExecutor`.
El tope efectivo es el mínimo entre todos los proyectos que permiten ese executor;
si alguno carece de tope explícito, el gate espera. No se modifica esa config.

La regla «sin nombres de modelo» se aplica a selección y política:
`executorSelection.ts`, `quotaGate.ts`, `modelPolicy.ts` y `worker.ts`.
Una regresión realiza el grep acotado a esos módulos. El Provider puede conocer
identificadores de modelo para interpretar su contexto; la tabla de ventanas de
`providers/hook/claude/constants.ts` permanece en el Provider. Los modelos opcionales
de Operator preferences se pasan al Executor sin fijarlos en esos módulos.

**Concurrencia y alcance.** Los slots exclusivos de
`~/.pixel-agents/executor-slots/<executor>/<n>.lock` son la autoridad para
lanzamientos del worker en esta máquina, entre repositorios y tareas distintas.
`concurrencyLimit` determina el número admisible de slots. La admisión serializa
la decisión actual del gate y el exclusive-create del slot por executor; un slot
se mantiene durante toda la Execution y se libera tras confirmar su fin.
Sin slot libre o con otra admisión en curso se devuelve `wait` con razón.
La sonda tiene límite 1, incluso si Operator config permite más concurrencia.

Cada lock registra PID, identidad de creación del proceso, executionId y token de
propiedad. La recuperación consulta únicamente esos PIDs registrados, nunca
explora procesos ajenos. Un propietario muerto o un PID reutilizado se recupera
bajo exclusión de admisión. Si se registró el hijo del Executor, también se exige
que haya desaparecido o cambiado de identidad; un hijo con identidad no verificable
se conserva mientras siga vivo. Locks corruptos, incompletos o una recuperación
interrumpida requieren comprobación manual y fallan cerrados.
Si el worker muere entre spawn y registro del PID hijo, una marca previa de
lanzamiento conserva el slot para recuperación manual: no se supone que el hijo
haya terminado. La identidad OS está
implementada para Windows (StartTime ticks) y Linux (boot ID + start ticks); otros
sistemas fallan cerrados. El lock de tarea conserva su recuperación manual previa.

El gate suma slots y sesiones observadas por oficinas, deduplicando sessionId
entre publicadores y contra los slots del runtime. Cuenta todas las sesiones
observadas, incluidas las que esperan, de forma conservadora. **No establece un
total de sesiones interactivas de máquina:** si falta observación o la cobertura
es parcial, su número total es desconocido; las sesiones interactivas no observadas
no se cuentan. Por tanto, el límite garantiza admisión del runtime, con una
reducción adicional por las sesiones observadas. No garantiza la concurrencia ni
la cuota de otros programas. No inspecciona archivos, datos ni procesos de Fundtrinsic.

**Publicación.** Solo el proceso que posee HTTP publica; reutilizar otro servidor
no concede propiedad. Cada arranque tiene un fichero distinto en
`~/.pixel-agents/machine-capacity.json.d/<pid>-<bootId>.json`. El antiguo fichero
único `machine-capacity.json` deja de ser fuente autoritativa. Cada contribución
declara identidad, contador de publicación y:

```json
{
  "coverage": {
    "scope": "office",
    "workspaces": ["D:/Source/project-a"],
    "source": "office_store"
  },
  "sessions": { "claude": [], "codex": ["session-id"] }
}
```

Cada propietario publica cada 15 s. Las contribuciones se agregan al leer y
caducan a los 60 s. Watch All Sessions puede ampliar la observación de Claude;
**no amplía Codex**: su watcher sigue filtrando por workspace. Providers distintos
de `undefined`/`claude` y `codex` no se atribuyen a ninguno de esos executors.
La cobertura publicada es siempre de oficina, nunca global.

El publicador no emite timestamps anteriores al último publicado en su arranque.
El lector rechaza retrocesos de timestamp o contador y limita la vida de una misma
generación con tiempo monotónico. Una generación caducada/futura/retrocedida se
marca en un directorio `.invalid` junto a su contribución; esa marca impide
revivirla tras un cambio de reloj, incluso al reiniciar el lector. Un nuevo
heartbeat válido o un nuevo arranque puede aportar nueva evidencia. No borrar
marcas mientras siga existiendo su contribución: la retención y limpieza de
publicadores históricos se deja al operador. Un salto adelante puede provocar
caducidad conservadora; se necesita un nuevo heartbeat válido para recuperar.

**Evidencia de cuota.** El heartbeat de sesiones y el evento de cuota son tiempos
distintos. `observedAt` de CapacitySnapshot procede del evento o su timestamp,
nunca del mtime; si no se conoce, queda null. Los ficheros contienen también
`evidence` compactada por ventana, conservando el tiempo de cada evento.

Un rechazo o porcentaje por encima del umbral se conserva hasta su `resetsAt`,
o hasta una observación posterior fiable de la misma ventana. Una observación
nueva con confianza baja/desconocida puede añadir restricciones, pero no borrar
las anteriores. Los lectores también conservan restricciones de publicadores
caducados. Un rechazo sin reset conocido requiere evidencia fiable posterior;
no se recupera por esperar 60 segundos. La ausencia de reset puede bloquear
indefinidamente y requiere revisar la fuente de cuota.

El rechazo se reevalúa por ventanas vigentes: si la única agotada reseteó,
`probe`; si otra sigue agotada, `wait`. Evidencia favorable con más de 60 s,
fecha futura/desconocida, publicador caducado, una ventana renovada o confianza
`low`/`unknown` permite como máximo `probe`, nunca `go`. No se añade autorización
para baja confianza a Operator config. Un reset no demuestra cuota disponible.

**Escritura y permisos.** Temporal único creado con `wx`, fsync y rename en el
mismo directorio; los fallos de escritura/rename limpian el temporal. En POSIX
se comprueba modo 0600 del temporal y del destino. En Windows, `mode: 0o600`
no establece una DACL privada: la protección depende de las ACL del perfil,
`~/.pixel-agents` y los archivos heredados. El operador debe restringirlas a su
cuenta y cuentas administrativas necesarias, como describe
[company-autopilot.md](company-autopilot.md). La QA real de Windows debe verificar
las ACL y el reemplazo; las pruebas sintéticas no acreditan la DACL del perfil.

**Configuración necesaria** (la escribe el operador fuera del repo):

```json
{
  "projects": {
    "softwareagents": {
      "autonomyLevel": "A1",
      "allowedExecutors": ["claude", "codex"],
      "concurrency": { "maxExecutions": 1, "perExecutor": { "claude": 1, "codex": 1 } },
      "quotaThresholds": { "claude": 10, "codex": 10 }
    }
  }
}
```

`quotaThresholds` es el porcentaje mínimo restante por executor. Los slots
reservan admisión del runtime, no cuota de cuenta: no son el ledger de SA-037.
Ledger, fallback de SA-038 y scoring ponderado quedan fuera de este cambio.

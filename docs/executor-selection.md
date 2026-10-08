# Selección y quota gate (SA-036, SA-QA-5)

`pixel-agents quota check --executor claude|codex --role <rol> [--json]`
devuelve 0 para `go` o `probe`, y 3 para `wait`. JSON incluye `reason` y,
en espera por cuota, `resetsAt` (epoch seconds; null si no se conoce).
También incluye `active` (slots gestionados) y `coverage`: oficinas, sesiones
observadas, sesiones del runtime, rutas de slots que requieren inspección y
exclusión de sesiones interactivas del límite del worker. El worker registra
esa misma cobertura.
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

Cada slot registra PID, identidad de creación, executionId y token. La admisión
usa turnos de Lamport: cada intento crea `<token>.claim` antes de elegir su turno,
seguido de `<token>.claim.ready`. Los nombres únicos evitan borrar el lock de una
generación nueva durante recuperación. Los turnos muertos se retiran por identidad;
los registros vacíos o incompletos tienen arrendamiento de 10 segundos. Un intento
que perdió su claim no puede entrar. EPERM/EACCES/EBUSY/EBADF/ENOENT se tratan como
contienda con reintento y plazo monotónico. Una identidad inaccesible conserva
capacidad, nunca demuestra muerte; los diagnósticos incluyen rutas de inspección.

El worker arranca un supervisor Node que solo puede lanzar el CLI después de
registrar durablemente su PID e identidad en el slot y recibir confirmación.
El supervisor permanece hasta el cierre del CLI. Antes del registro, una muerte
del worker hace salir al supervisor sin lanzar el executor; después, el slot
mantiene el proceso registrado hasta verificar su fin. Las marcas `launchPending`
antiguas sin este protocolo conservan recuperación manual. Solo se consultan PIDs
registrados. Windows usa StartTime con fallback CIM por PID; Linux usa boot ID y
start ticks; Darwin/BSD usa `ps -o lstart= -p PID`, con precisión de un segundo.
La caché de identidad dura 30 s, comprueba existencia en cada consulta y fuerza
consulta nueva ante discrepancias. El lock de tarea conserva recuperación manual
tras una muerte abrupta.

**Qué cuenta.** `concurrency.perExecutor` limita exclusivamente Executions
gestionadas mediante slots del runtime, entre repositorios. Las sesiones
interactivas, incluidas las inactivas, se deduplican y declaran en `coverage.counts`,
pero no consumen slots ni la sonda. El Operator puede mantener su sesión Claude
abierta y ejecutar un worker con límite 1. Las oficinas siguen aportando evidencia
de cuota. No se garantiza la concurrencia ni la cuota de otros programas, ni se
establece un total global de sesiones interactivas. No se inspeccionan archivos,
datos ni procesos de Fundtrinsic.

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

Al retroceder el reloj, el publicador abre una época nueva y sigue publicando,
conservando restricciones de cuota. El lector limita una generación con tiempo
monotónico y marcas de caducidad compartidas en `.invalid`. Rechaza fechas futuras
por más de 1 s; el margen evita invalidar un heartbeat escrito unos milisegundos
después de tomar `nowS`. El gate sigue negando `go` a eventos de cuota futuros.
Las sesiones de publicaciones futuras siguen como telemetría si el PID y la
identidad del publicador están vivos. Un nuevo heartbeat o época restablece
cobertura fresca. No borrar marcas mientras exista su contribución: su limpieza
histórica corresponde al operador.

**Evidencia de cuota.** El heartbeat de sesiones y el evento de cuota son tiempos
distintos. `observedAt` de CapacitySnapshot procede del evento o su timestamp,
nunca del mtime; si no se conoce, queda null. Los ficheros contienen también
`evidence` compactada por ventana, conservando el tiempo de cada evento.

Un rechazo o porcentaje por encima del umbral se conserva hasta su `resetsAt`,
o hasta una observación posterior fiable de la misma ventana. Una observación
se asocia por `limitId` del Provider (seven_day_opus, seven_day_sonnet, overage),
con `kind` como fallback para evidencia anterior. Tipos distintos no se sustituyen.
Un reloj que retrocede no elimina restricciones futuras; estas solo pueden
restringir y se degradan a confianza baja. Una observación
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

**Configuración para selección automática** (la escribe el operador fuera del repo):

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

`quotaThresholds` es el porcentaje mínimo restante por executor. Los Projects
con configuración antigua sin límite no anulan los límites explícitos de otros
Projects; estos se agregan por el mínimo. `quota check` y selección automática
requieren umbrales explícitos y un límite configurado. El worker manual sin `--select-executor`
usa un slot y umbral 0% cuando faltan estos campos, respeta rechazos conocidos y
solo permite una sonda con cuota desconocida. Los slots
reservan admisión del runtime, no cuota de cuenta: no son el ledger de SA-037.
Ledger, fallback de SA-038 y scoring ponderado quedan fuera de este cambio.

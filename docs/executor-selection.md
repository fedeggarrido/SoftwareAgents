# Selección, niveles de modelo y quota gate (SA-036, SA-084, SA-QA-5)

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
por capabilityClass del Developer. Sin catálogo de niveles ni ese flag se conserva la preferencia Claude,
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
El ledger de cuota y la recuperación de Executions agotadas de SA-038 siguen fuera de este cambio.

## Niveles de modelo (SA-084)

El operador define `projects.<id>.modelTiers` exclusivamente en
`~/.pixel-agents/config.json`. Los nombres estables son **economy, standard, deep**;
un nivel ausente no existe. No se adoptó Executor local (ADR-0004 Rejected).
Los modelos de este ejemplo son sintéticos: el operador debe sustituirlos por IDs
disponibles en su cuenta antes de ejecutar. El repo nunca declara modelos.

```json
{
  "projects": {
    "softwareagents": {
      "autonomyLevel": "A1",
      "allowedExecutors": ["codex", "claude"],
      "quotaThresholds": { "codex": 10, "claude": 10 },
      "concurrency": { "maxExecutions": 1, "perExecutor": { "codex": 1, "claude": 1 } },
      "modelTiers": {
        "maxTier": "standard",
        "tiers": {
          "economy": {
            "candidates": [{ "executor": "codex", "model": "test-economy-model", "effort": "low" }]
          },
          "standard": {
            "candidates": [
              { "executor": "codex", "model": "test-standard-model", "effort": "medium" },
              { "executor": "claude", "model": "test-standard-alternative" }
            ],
            "fallbackTo": "economy"
          },
          "deep": {
            "candidates": [{ "executor": "claude", "model": "test-deep-model", "effort": "high" }],
            "fallbackTo": "standard"
          }
        }
      }
    }
  }
}
```

`maxTier` es obligatorio y debe existir: limita cualquier petición del repo.
El operador también puede poner `modelTiers.rule`, con el mismo esquema que
`tierRule` abajo; esa regla prevalece sobre el repo y permite operar con políticas
anteriores sin `tierRule`. `allowedExecutors` sigue siendo la única allowlist.
Ningún candidato, peso o nivel amplía permisos, tools, sandbox o autonomía.

### Regla declarativa y entradas reales

En `.softwareagents/agents/model-policy.yaml`, `tierRule` contiene exclusivamente
pesos enteros no negativos y umbrales crecientes. No admite modelos ni autoridad:

```yaml
tierRule:
  capabilityWeights:
    { fast_cheap: 0, standard_coding: 2, review: 2, test_analysis: 2, high_reasoning: 4 }
  workTypeWeights:
    { summary: 0, classification: 0, docs: 0, implementation: 0, review: 1, qa: 1, architecture: 2 }
  sizeWeights: { S: 0, M: 1, L: 2 }
  thresholds: { economy: 0, standard: 2, deep: 4 }
```

Se suma capabilityClass + tipo + tamaño y se elige el mayor umbral alcanzado,
acotado por `maxTier`. Con la tabla anterior: Developer/implementation/S → standard;
Developer/review/M → deep; fast_cheap/summary/S → economy.
QA declara `test_analysis` (peso 2). El worker sigue ejecutando el AgentSpec Developer: el rol de la Task no cambia
sus permisos ni el template. Un capabilityClass sin peso produce espera explícita.

El tipo sale de `Task.type` del WorkStore si coincide con uno de los siete IDs
anteriores. El tamaño sale de `items[].size` (S/M/L) del board vinculado mediante
`project.yaml → legacy.boardFile`, con coincidencia única por Task key.
SA-020 compila contexto/roles; no importa una estimación de Task. El brief no se
interpreta para decidir modelos. Si falta o es desconocido **cualquiera** de tipo o
tamaño, se utiliza solo capabilityClass; la explicación registra `fallback: missing
work type/size, capabilityClass only`. No se adivina a partir del título o longitud.

### Cuota, bajadas y admisión

Cada nivel prueba sus candidatos en orden contra el mismo snapshot de SA-036,
filtrados por `allowedExecutors`. `go` o `probe` admite el primero elegible.
Solo un rechazo de cuota o saldo bajo permite seguir `fallbackTo`, y solo si
`AgentSpec.modelPolicy.fallbackAllowed` es true. El destino debe existir y ser
inferior; no hay subida, ciclos ni salto implícito sobre niveles ausentes.
Un límite de slots por sí solo no permite bajar. El tope del operador se aplica
antes de las bajadas por cuota. Si ningún candidato entra, devuelve `wait`/3
con el reset conocido más temprano entre los candidatos intentados (null si no
hay ninguno), para reevaluar; no promete disponibilidad después de ese reset.
Dentro de cada candidato, SA-036 conserva la espera por todas sus ventanas.

El worker adquiere las admisiones existentes en orden fijo claude → codex, lee
una sola observación y reserva únicamente el slot del ganador antes de soltarlas.
Los owners, supervisores, recuperación y duración de slots de SA-QA-5 se conservan.
La reserva no garantiza cuota frente a trabajo externo. Los toggles futuros de
SA-086 reutilizan este catálogo y estos nombres; la coordinación de cambios de
autoridad inmediatamente antes del spawn sigue perteneciendo a ese diseño.

### Validación y compatibilidad

Modelo: ID de 1–128 caracteres, empieza con alfanumérico y solo acepta
alfanuméricos, punto, guion bajo, dos puntos, barra y guion. No acepta opciones,
espacios, comillas o saltos de línea. Codex recibe `-m <id>` y
`-c model_reasoning_effort="<valor>"`; allowlist cerrada:
`none | minimal | low | medium | high | xhigh`.
Evidencia local: `codex-cli 0.160.0`, `codex exec --help` confirma TOML y `-m`;
`codex app-server generate-json-schema` define ReasoningEffort como string no vacío.
La allowlist es un subconjunto conservador de esa sintaxis, no garantía de que
cada modelo admita todos los esfuerzos. Claude debe comprobar su modelo real.

Claude recibe `--model <id>` y, si se pide esfuerzo, `--effort <valor>` únicamente
tras comprobar `--help` del binario configurado (sin prompt, timeout 3 s,
salida limitada, sin shell ni cwd del repo). La CLI inspeccionada anuncia
`low | medium | high | xhigh | max`. Si el binario no anuncia el flag/valor, no
responde o falla, la config es inválida: error claro, sin lanzamiento. Se vuelve
a comprobar al crear la Execution. El soporte no se presume por versión.
Los Executors vuelven a validar antes de construir argv, incluidos llamadores
ajenos al worker. Una config de niveles inválida falla al cargar y no se ignora.

Sin `modelTiers`, no se añade modelo ni esfuerzo: se conserva la ruta manual
Claude y `--select-executor` conserva el selector SA-036. La política del repo
admite las preferencias antiguas por capabilityClass más `tierRule` opcional;
rechaza `model` en preferencias, ya que no debe residir en el repo. Configs y
clientes anteriores siguen funcionando; `agentRole` solo incorpora campos
opcionales `tier`, `model`, `effort`, `selectionReason`, sin nuevas variantes
(35 server / 24 client). El overlay muestra la elección histórica de la Execution,
nunca la config actual ni una inferencia de la Session interactiva.

WorkStore migra idempotentemente a v6 con `model_tier`, `model_effort` y
`selection_reason`; `model_id` y `executor` ya existían. El worker manual registra
el intento con PID nulo: tiene lock de tarea, no lease del WorkStore. El PID real,
identidad y Session permanecen en registry/slot del supervisor. No cambia el
lifecycle de una Task existente. Si falta la Task se crea solo la referencia
necesaria con tipo `unknown` y estado DRAFT, para no inventar clasificación en
futuros intentos. La selección se audita de forma verificable
antes de lanzar (`model_selected`) y acompaña el resultado de la Execution.

### Explicación sin gastar cuota y prueba real

Desde el checkout con Project válido y el catálogo del operador:

```powershell
node dist/cli.js quota check --select-executor --role developer --work-type implementation --size S --json
node dist/cli.js quota check --select-executor --role developer --work-type architecture --size L --json
node dist/cli.js quota check --select-executor --role reviewer --work-type review --size M --json
node dist/cli.js quota check --select-executor --role developer --json
```

Estos comandos no lanzan Executors ni reservan slots. JSON incluye status,
requestedTier, tier, executor, model, effort, downgrades, reason y cobertura.
0 = go/probe; 3 = wait; argumentos o config inválidos = error/1. La forma antigua
`quota check --executor codex --role developer --json` conserva su diagnóstico
directo del gate, sin resolver niveles.

Claude compara maxTier y fallback de entradas ausentes, observa una cuenta ya
limitada para comprobar bajadas/espera sin provocar agotamiento, y prueba una
Task de QA preparada (clave SA real asignada por el operador):

```powershell
node dist/cli.js worker run --task $taskKey --brief $briefPath --select-executor
```

Debe ver modelo/esfuerzo en argv efectivo del CLI, la misma selección en
`<git-common-dir>/softwareagents/work.sqlite3` y `executions.jsonl`, y
`model_selected` más resultado en el audit del Project bajo `~/.pixel-agents`.
En la oficina standalone, al pasar sobre o seleccionar el Character de esa Session,
debe aparecer `standard · <modelo>` (o el nivel elegido), con esfuerzo/motivo en
el tooltip. Reconexionar debe mantenerlo. La oficina requiere esa Session observada;
una sesión interactiva ajena no recibe nivel inventado. La prueba real e integración
siguen pendientes de Claude.

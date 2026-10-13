# SA-086 · Disponibilidad de Executors en Pixel Office

Fecha: 2026-10-03. Estado: propuesta de Codex; **pendiente de revisión manual de Claude**.
Alcance: investigación y diseño, sin implementación, instalaciones ni cambios en ClickUp.
Dependencias previstas: SA-036 (selección y quota gate), SA-084 (economy/standard/deep
en Operator config) y SA-085 (LLM local mediante `codex exec --oss`). No se presupone
que esas ramas estén integradas ni que sus contratos finales coincidan con los nombres
provisionales de este documento.

## Decisión y principio

**El operador decide la disponibilidad; el programa decide la asignación.** Un toggle
autoriza o excluye un Executor para nuevas Executions de un Managed Project. No asigna
Tasks, selecciona Characters ni permite saltarse gates. El selector determinista de
SA-036/SA-084 decide Executor, nivel y Model entre candidatos autorizados, compatibles
con el AgentSpec, técnicamente disponibles y admitidos por cuota y concurrencia.

Agent ≠ Executor ≠ Model: el Agent conserva identidad y permisos al cambiar de
Executor. Una Session adoptada o un Character visible no concede autoridad ni prueba
capacidad. La oficina proyecta el runtime, nunca toma decisiones de ejecución.
El toggle tampoco instala hooks, autentica CLIs, descarga modelos o inicia un servidor
local; esas operaciones necesitan sus propios flujos de configuración.

Se propone reutilizar `projects.<id>.allowedExecutors` como única fuente de habilitación.
No añadir un segundo mapa `enabled` que pueda contradecirlo. El estado técnico y la
capacidad son observaciones separadas y no alteran automáticamente esa preferencia.
El alcance es por Project y compartido entre adapters; los límites de máquina y cuenta
siguen siendo límites adicionales, no se elevan desde este panel.

## Base investigada y encaje con trabajo paralelo

| Fuente                                                                                                                                                        | Evidencia actual e implicación                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AGENTS.md](../../AGENTS.md), [CLAUDE.md](../../CLAUDE.md), [CONTEXT.md](../../CONTEXT.md)                                                                    | Capas estrictas, AsyncAPI 3.0, revisión cruzada manual y terminología SoftwareAgents. `core/src/messages.ts` se genera; los adapters comparten protocolo.                                                                                                                    |
| [Threat model](../security/threat-model.md)                                                                                                                   | Contenido del repo sin autoridad, token bearer reutilizable, cuota compartida y aislamiento de configuración distinto del sandbox de SO. Habilitar un Executor no resuelve esos riesgos.                                                                                     |
| [project.ts](../../core/src/project.ts), [configPersistence.ts](../../server/src/configPersistence.ts), [projectConfig.ts](../../server/src/projectConfig.ts) | Operator config externo en `~/.pixel-agents/config.json`, por Project id. Ausencia de política → A0 y lista vacía. `parseProjects` rechaza políticas inválidas completas; `writeConfig` hace tmp+rename, pero captura errores y no confirma éxito.                           |
| [policy.ts](../../server/src/policy.ts)                                                                                                                       | `evaluatePolicy` es puro y usa autonomía confiable. Acciones con mínimo `null` requieren humano para actores agent/system. Un `allow` no reemplaza autorización, cuota ni otras guardias.                                                                                    |
| [clientMessageHandler.ts](../../server/src/clientMessageHandler.ts)                                                                                           | `setHooksEnabled` verifica privilegio, aplica el efecto, comprueba resultado y luego persiste. Los controles company llaman a policy. Se conserva ese orden, con validación estricta y errores explícitos.                                                                   |
| [Executors](../../server/src/executors/)                                                                                                                      | IDs actuales `claude`/`codex`, flags del llamador prohibidos, AgentSpec compilado y cancelación explícita. Codex resuelve binario confiable y rechaza override inválido. Registry registra Execution/Session, pero no es por sí solo un ledger completo de capacidad activa. |
| [worker.ts](../../server/src/worker.ts)                                                                                                                       | Hoy selecciona Claude y verifica su allowlist al inicio. SA-036 debe llevar todos los lanzamientos al selector común; los toggles requieren revalidación inmediatamente antes del spawn real, también en generadores lazy.                                                   |
| [CompanyHud.tsx](../../webview-ui/src/components/CompanyHud.tsx), [capacityView.ts](../../webview-ui/src/office/capacityView.ts)                              | HUD expandido y variante mínima si falta board. Capacidad observada preserva desconocidos. `visibleProviderCounts` cuenta Sessions, incluidas inactivas: no usarlo como ocupación ni como identificación de local.                                                           |
| [PixelAgentsViewProvider.ts](../../adapters/vscode/PixelAgentsViewProvider.ts)                                                                                | La webview embebida recibe privilegio por construcción y despacha hooks directamente; no pasa hoy todo por `handleClientMessage`. El nuevo control debe delegar en un servicio común, sin duplicar política.                                                                 |
| [auditLog.ts](../../server/src/auditLog.ts)                                                                                                                   | `AuditLog.append` ofrece errores verificables y redacción; `recordAudit` oculta fallos. Los cambios de autoridad necesitan la variante verificable. El input se guarda como hash, no como valores de antes/después recuperables.                                             |

Integración prevista, pendiente de contrastar con los contratos finales:

- **SA-036:** añadir disponibilidad como filtro del selector existente; reutilizar su
  quota gate, razones de descarte y reglas para cuota desconocida/obsoleta. No crear
  otro ranking ni un quota gate en React.
- **SA-084:** reutilizar la configuración y resolución de niveles economy/standard/deep
  del operador. El MVP muestra niveles admitidos en modo lectura. Controles opcionales
  por nivel se implementan después mediante el mismo servicio privilegiado, sin
  inventar un bloque paralelo de modelos. Un cambio de nivel tampoco asigna Tasks.
- **SA-085:** usar su ID final para local y sus comprobaciones de provider/modelo.
  Aquí se usa **`codex-local` como nombre provisional**. Claude/Codex cloud/local son
  tres destinos distinguibles para política, audit y UI; Codex cloud y local pueden
  compartir binario y permisos, pero no cuota de suscripción. Si SA-085 representa
  local como modo, el selector debe normalizar un destino inequívoco antes del wire.

## UX en la oficina

Añadir «Executors para nuevas tareas» al HUD expandido, con Project id inequívoco.
Debe funcionar incluso sin board/quota: el estado viene del runtime del Project,
no del espejo del backlog. Si no hay Managed Project válido, mostrar «Sin proyecto
gestionado» y controles inactivos; no migrar automáticamente workspaces heredados.

```text
▾ SoftwareAgents                         Tareas · Decisiones
Executors para nuevas tareas       Asignación: automática por política

[ON ] Claude       Disponible                 1 ejecución / límite 1
      standard, deep · Cuota observada sana · hace 20 s
[ON ] Codex        Sin cuota                  0 ejecuciones / límite 1
      economy, standard, deep · renovación 18:00
[OFF] LLM local    Desactivado                1 ejecución terminando
      Motor detectado: servidor no disponible · comprobado hace 12 s

Tú eliges qué puede usarse. El programa decide quién hace cada tarea.
Desactivar deja terminar las ejecuciones en curso.
```

El switch expresa **habilitación del operador**, mientras el texto expresa elegibilidad
actual. ON puede coexistir con «No instalado», «Versión incompatible», «Autenticación
necesaria», «Servidor local no disponible», «Modelo local no disponible», «Sin cuota»,
«Límite de concurrencia» o «Desconocido / comprobando». OFF muestra «Desactivado» como
estado principal y mantiene el diagnóstico técnico en detalle. No colorear desconocido
como disponible; las razones completas se conservan aunque se elija una principal.

- Sin privilegio: estado visible, switches deshabilitados y texto «Solo el operador
  puede cambiar la disponibilidad». El servidor entrega esa capacidad al conectar.
- Mientras se aplica: switch bloqueado, «Guardando…», sin actualización optimista.
  Solo el resultado confirmado cambia el estado; timeout/desconexión pide snapshot.
- Si se apagan todos: aceptar el cambio y mostrar aviso persistente «Nuevas tareas
  bloqueadas: todos los executors están desactivados». No usar confirmación modal:
  es reversible y el efecto está explicado junto a los switches.
- ON con CLI ausente es válido: guarda autorización futura y muestra «No instalado»;
  no instala ni arranca nada. Un ID desconocido no es un CLI ausente: se rechaza.
- Accesibilidad: switch con nombre del Project/Executor, teclado, estado checked,
  motivo legible y aviso `aria-live`; no depender solo de color.
- Las ejecuciones activas vienen del ledger/runtime. Las Sessions observadas siguen
  mostrándose con su nombre correcto, fuera del contador de ocupación autorizada.

Overlay del Character asociado a una Execution:

```text
Developer · SA-123 · ejecución e-42
Codex · standard · modelo resuelto por la política
Elegido: nivel compatible, cuota admitida y slot reservado.
Alternativas: Claude desactivado; local no admite el nivel requerido.
Decisión d-17 · política vN · configuración r8 · observación 16:41:20
```

Las razones son datos de la decisión real de lanzamiento, no inferencias de React ni
del LLM. Se conserva la decisión histórica aunque luego cambien los toggles. Para
Sessions adoptadas sin Execution: «Sesión externa; asignación no gestionada», sin
inventar razones ni prohibir su observación.

## Protocolo AsyncAPI propuesto

Añadir variantes a las uniones `oneOf` de `core/asyncapi.yaml` 3.0.0, discriminator
`type`, objetos cerrados con `additionalProperties: false`; regenerar bindings y
validar drift. Los ejemplos siguientes son contrato propuesto, no tipos implementados.
Validar payloads también en runtime: los cast TypeScript actuales no bastan.

### ClientMessage

```json
{
  "type": "setExecutorEnabled",
  "projectId": "softwareagents",
  "executorId": "claude",
  "enabled": false,
  "requestId": "req-17",
  "expectedRevision": "r8"
}
```

Todos los campos obligatorios. `enabled` boolean estricto; Project id canónico y
vinculado al workspace resuelto por el servidor; executor del catálogo registrado;
requestId no vacío con longitud limitada (máximo 128), revision opaca emitida por
servidor. Nunca aceptar actor, autonomía, binario, argv, endpoint o modelo en este
mensaje. Es un comando absoluto, no «invertir» el valor: repetirlo no lo invierte.

```json
{ "type": "requestExecutorState", "projectId": "softwareagents" }
```

Lectura para reconectar/resincronizar; no dispara procesos costosos por cada request.
El handshake `webviewReady` también envía automáticamente el snapshot. Si hacen falta
refreshes manuales de probes, deben ser privilegiados y limitados, fuera de este MVP.

### ServerMessage

`executorState`: snapshot completo del Project, enviado al conectar y difundido tras
cambios de autoridad, probes o capacidad. `canManage` se calcula por destinatario y
no se reutiliza indiscriminadamente al hacer broadcast.

```json
{
  "type": "executorState",
  "projectId": "softwareagents",
  "revision": "r9",
  "sequence": 34,
  "observedAt": 1791046800,
  "canManage": true,
  "configurationStatus": "ready",
  "executors": [
    {
      "executorId": "claude",
      "enabled": false,
      "eligible": false,
      "reasonCodes": ["operator_disabled"],
      "installation": "ready",
      "version": "validated-version",
      "authentication": "ready",
      "localService": "not_applicable",
      "levels": ["standard", "deep"],
      "quotaGate": "allow",
      "activeExecutions": 1,
      "concurrencyLimit": 1,
      "checkedAt": 1791046780,
      "staleAfter": 1791046840
    }
  ]
}
```

El snapshot contiene los tres destinos del catálogo. `eligible` significa admisible
para consideración ahora; no garantiza aceptación para una Task concreta ni reserva
un slot. `revision` cambia solo al cambiar Operator config; `sequence` ordena snapshots
dentro de la conexión y se reinicia al reconectar. Tiempos en epoch seconds, como
CapacitySnapshot. Campos sin dato (`version`, tiempos o límite) aceptan `null`.
Límites ausentes se muestran como desconocidos, nunca como infinitos por defecto.

Enums propuestos: installation `ready|missing|unsupported|unknown`;
authentication `ready|required|unknown|not_applicable`;
localService `ready|unreachable|model_missing|unknown|not_applicable`;
quotaGate `allow|block|unknown|not_applicable`;
configurationStatus `ready|pending|recovery_required|invalid`.
Reason codes incluyen `operator_disabled`, `not_installed`, `unsupported_version`,
`auth_required`, `probe_unknown`, `probe_stale`, `local_unreachable`,
`local_model_missing`, `quota_blocked`, `quota_unknown`, `concurrency_full`,
`no_allowed_level` y `configuration_unavailable`. Reutilizar los códigos de SA-036
donde existan, con textos seguros derivados en UI. Mantener las ventanas/source/
confidence de CapacitySnapshot como detalle, sin duplicar porcentajes en este mensaje;
local muestra cuota de suscripción «No aplica», no «100 % libre».

`executorToggleResult`: respuesta punto a punto correlacionada, nunca mensaje efímero
como única confirmación del cambio.

```json
{
  "type": "executorToggleResult",
  "projectId": "softwareagents",
  "executorId": "claude",
  "requestId": "req-17",
  "status": "applied",
  "errorCode": null,
  "revision": "r9"
}
```

status `applied|unchanged|rejected|failed`; errorCode
`null|unauthorized|invalid_request|unknown_project|unknown_executor|policy_denied|revision_conflict|apply_failed|persist_failed|audit_failed|recovery_required`.
Enviar snapshot verdadero después de conflictos/fallos cuando el Project sea visible.
`applied` implica aplicado **y persistido y auditado**. Un cliente antiguo que no recibe
esta capacidad mantiene el panel en lectura; no encolar cambios offline ni reproducir
los nuevos comandos automáticamente desde la send queue de WebSocket.

Para razones por Execution proponer `executionAssignment` con projectId, taskKey,
executionId, sessionId (nullable hasta asociación), decisionId, executorId, level,
model (nullable), policyVersion, configRevision, decidedAt, reasonCodes y alternativas
descartadas (executorId + reasonCodes). Es un evento persistido proyectado y reenviado
al handshake para las Executions visibles. Si SA-036/SA-084 ya ofrecen una proyección
equivalente, ampliarla en vez de crear otra. La unión debe definir campos y enums
cerrados; no introducir `Record<string, any>` para el trace.

## Persistencia, política y seguridad

Ejemplo de habilitación, usando ID local provisional:

```json
{
  "projects": {
    "softwareagents": {
      "autonomyLevel": "A2",
      "allowedExecutors": ["claude", "codex", "codex-local"],
      "concurrency": {
        "maxExecutions": 2,
        "perExecutor": { "claude": 1, "codex": 1, "codex-local": 1 }
      }
    }
  }
}
```

Los toggles solo añaden/quitan membresía; preservan niveles SA-084, binaryPaths,
umbrales, budgets y otras claves. No guardar preferencia en repo, board, layout,
VS Code workspace settings o namespaces `vscode`/`standalone`. Config ausente o
inválida no habilita nada; un toggle no crea silenciosamente un Project ni repara
políticas inválidas. CLI instalado o actualización del catálogo nunca implica ON.
Para configs antiguas conservar la lista explícita; ausencia de local implica OFF.
Un ID legado desconocido se conserva como diagnóstico sin ejecutarlo ni borrarlo
al cambiar otra fila; cambios nuevos admiten solo IDs registrados.

Añadir acción **`change_executor_availability: null`** a POLICY_ACTIONS. Resolver
Project y autonomía en servidor y evaluar `evaluatePolicy(action, actor, level)`.
Solo cliente privilegiado del operador puede mutar: comprobar privilegio incluso
para desactivar y aunque A4 esté configurado. Un origen agent/system no pasa por la
UI humana; la acción exige humano en todos los niveles y no modifica config. No
fiarse de `msg.actor` ni de un texto de aprobación en brief/AgentSpec. Activar no
autoriza lanzar: cada nueva Execution vuelve a evaluar `launch_execution` con su
actor real y todas las guardias. No trasladar el actor humano del toggle al scheduler.

Servicio común propuesto en `server/`, llamado por ambos adapters:

1. Autenticar conexión y validar payload, catálogo y binding de Project. Auditar
   rechazos con actor unknown cuando no hay autenticación; no filtrar proyectos ajenos.
2. Serializar mutación con el dispatch del Project y adquirir lock de configuración
   **de archivo completo** entre procesos. Todos los writers de config deben cooperar:
   el archivo también contiene hooks y namespaces; un mutex por Project no evita
   lost updates. No robar locks caducados sin recuperación verificada.
3. Releer y validar config sin convertir un fallo de lectura en `{}` para escribir;
   comparar expectedRevision con fingerprint canónico del bloque Operator completo
   del Project. Rechazar conflicto con snapshot. Validar policy desde esta lectura.
4. Registrar intención durable en audit (`AuditLog.append`, fallo aborta). Incluir
   requestId y old/new allowlist en detalle estructurado/redactado, dentro del tamaño
   permitido. El inputHash actual solo verifica input, no permite reconstruir el cambio.
5. Congelar nuevos dispatches del Project y aplicar la nueva allowlist al estado
   efectivo del runtime, incrementando su generación. Verificar aplicación sin tocar
   handles existentes. Invalidar selecciones/reservas todavía no lanzadas.
6. **Persistir después de aplicar**, con writer que lance error o confirme resultado:
   tmp único por operación, permisos, fsync/rename y lectura de verificación.
   No usar como evidencia de éxito el `writeConfig` actual, que oculta fallos.
7. Registrar resultado durable de la misma intención; solo entonces liberar nuevos
   dispatches, responder applied y difundir estado mediante la capa de broadcast.

En fallo de persistencia, restaurar estado anterior mientras el dispatch sigue
congelado y verificar disco; informar failed y auditar la compensación. Si rename
pudo completarse, audit de resultado falla o rollback no puede verificarse, mantener
**el Project bloqueado para nuevos lanzamientos**, publicar recovery_required y
reconciliar intención/disco/runtime antes de abrir el dispatch. No afirmar atomicidad
entre JSON y audit: no hay transacción común. En crash, los procesos deben comprobar
intenciones sin resultado antes de lanzar, registrar recuperación y verificar config;
locks huérfanos requieren la recuperación segura existente. Una desactivación fallida
no debe quedar escondida ni reactivarse tras reinicio sin aviso al operador.

No incluir tokens, rutas del perfil, stdout de autenticación ni endpoints con secretos
en snapshots/audit. Los probes y Executors no reciben el token privilegiado de la
oficina. Bearer token ≠ identidad personal verificable: esta propuesta usa el modelo
local supervisado vigente, con separación de credenciales de Agent ingress. La
mitigación del token en URL sigue en SA-075, fuera del toggle.

## Asignación determinista y cambios durante trabajo

El selector común considera en orden: autoridad del Project y límites de máquina,
AgentSpec/capabilityClass y niveles/modelos SA-084, detección técnica, cuota SA-036,
budgets y slots. Usa el ranking/tie-break estable de esas tareas; registra entradas,
versiones, ganador y descartes. El LLM puede aportar datos de una Task, pero no
construye la allowlist ni decide el Executor efectivo. No degradar a economy/local
para eludir requisitos de calidad o `fallbackAllowed: false`.

La selección se revalida bajo la coordinación de dispatch justo antes del **spawn**,
no solo antes de `Executor.start`: los eventos pueden ser lazy y la cuota puede variar.
Un lanzamiento que ya cruzó esa frontera termina con su configuración de origen;
una selección o handle sin proceso iniciado debe invalidarse/reseleccionarse. Reservas
de capacidad del runtime no equivalen a cuota reservada en la cuenta. Con varios
workers/adapters, SA-036 y el ledger deben compartir generación/lock; si aún no pueden
garantizarlo, permitir un solo dispatcher por Project hasta implementarlo.

| Cambio/caso                                | Resultado requerido                                                                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desactivar con Executions en curso         | No cancelar, matar proceso ni cerrar Session/Character. Mostrar drenaje. Reintentos y continuaciones que lanzan un nuevo proceso vuelven a política.                                                                |
| Desactivar con selección pendiente         | Liberar reserva no lanzada, volver a seleccionar sin nuevo lease duplicado ni ejecutar dos veces la Task.                                                                                                           |
| Activar                                    | Recalcular pendientes tras éxito durable. No adelantar dependencias, saltar Human Decisions ni arrancar autopilot por sí solo.                                                                                      |
| Todos OFF o ningún nivel autorizado        | Bloqueo explícito `no_enabled_executor`/`no_allowed_level`; una Human Decision deduplicada por causa y Project. No generar una decisión por cada tick.                                                              |
| Sin executor por cuota/concurrencia        | Espera automática de recurso; reevaluar al reset observado, slot liberado o nueva lectura. No solicitar una Human Decision para cada saturación temporal.                                                           |
| CLI/auth/local no disponible o desconocido | No ejecutar candidato cuya compatibilidad no pueda probarse. Reintento con backoff; diagnóstico y escalación si requiere instalación/autenticación del operador.                                                    |
| Cambio de cuota tras selección             | Revalidación; si el proceso reporta agotamiento, usar la recuperación SA-036/SA-038. No migrar proceso en vivo ni repetir trabajo automáticamente sin comprobar efectos.                                            |
| Cuota desconocida/obsoleta                 | Mostrarla así y aplicar exactamente la regla de SA-036. No inventar saldo ni llamar «disponible» al executor si el gate no lo admite.                                                                               |
| Fallo del servidor local durante Execution | Registrar fallo; fallback solo si lo permite la política y como nueva Execution tras gestionar outputs/lease, sin forzar nube deshabilitada.                                                                        |
| Dos clientes cambian a la vez              | Un writer gana por revision; el otro recibe conflict y estado actual. Repetición exacta de requestId/payload devuelve resultado conocido; payload distinto con mismo ID se rechaza.                                 |
| Desconexión tras click                     | Resultado incierto hasta snapshot; no replay offline. Repetir comando absoluto tras revisión de estado, con nueva revisión.                                                                                         |
| Config editada fuera de UI                 | Recargar con validación y coordinación común antes de nuevos spawns. Bloque inválido → sin nuevas ejecuciones; registrar cambio externo como system/autor desconocido. No confundir file edit con autenticación UI. |
| Project equivocado o no gestionado         | Rechazar; no inferir identidad por nombre del board ni crear autorización heredada.                                                                                                                                 |

Para bloqueo que exige operador usar `WAITING_HUMAN` cuando el WorkStore/Task lifecycle
lo soporte. Si aún no existe esa transición, mantener Task pendiente/bloqueada con
código y aviso persistentes; **no introducir un estado fantasma en board.json**.
Al recuperar disponibilidad, cerrar el bloqueo por causa y reevaluar Tasks, sin cerrar
otras Human Decisions ni mover Tasks terminadas o en revisión. Una Execution activa
no pasa a WAITING_HUMAN solo porque su Executor se deshabilite.

## Detección de disponibilidad por Executor

Un monitor en `server/` publica observaciones separadas de autorización. Probes sin
prompts, sin consumo intencionado de cuota, con timeout, salida limitada, argv fijo,
sin shell y sin cwd/config de repo no confiable. Binarios y endpoints solo del operador;
un override inválido falla cerrado sin buscar otro binario silenciosamente.

| Destino         | Detección requerida                                                                                                                                                                                            | Límites de la evidencia                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude          | Resolver binario autorizado; versión/capabilities para flags aislados y stream-json que usa ClaudeCliExecutor; estado de auth mediante probe de lectura soportado por esa versión. Capacidad desde SA-035/036. | Hooks instalados no prueban auth ni son requisito de ejecución: hoy el Executor puede omitirlos. Archivo de credenciales presente no prueba login válido. |
| Codex cloud     | Reutilizar resolveCodexBinary (incluida `.exe` en Windows); verificar versión/capabilities de exec/json/sandbox/perfiles compilados; estado de login de lectura soportado y cuota cloud.                       | Presencia en PATH no prueba autenticación ni permisos efectivos. CLI exit 0 en --version solo prueba versión.                                             |
| Local vía Codex | Mismo resolver de binario; capacidad `--oss` según SA-085; provider/endpoint/modelo autorizado; health y catálogo de modelos locales, sin generación ni descarga. Auth cloud `not_applicable`.                 | Servicio responde ≠ modelo cargado ni RAM/GPU suficiente. No consultar cuota cloud como cuota local; usar límites de recursos/concurrencia de SA-085.     |

No fijar versiones mínimas numéricas sin la matriz probada de SA-033/034/085.
El catálogo de runtime debe declarar la mínima probada y capabilities obligatorias;
versiones anteriores/parse desconocido quedan unsupported/unknown, no compatibles
por adivinación. Los comandos exactos de auth se verifican en implementación contra
los CLIs soportados; si no existe probe seguro, dejar unknown y requerir diagnóstico
del operador. No realizar una Execution de prueba al pulsar ON.

Cache propuesto: inspección al arrancar para destinos ya autorizados, al habilitar y
tras cambio de binario/config; refresh de destinos habilitados cada 60 s, timeout 3 s
por probe y backoff hasta 5 min en fallo. Son valores de diseño ajustables, no evidencia
de disponibilidad. Cambios de auth no observables exigen TTL; al lanzar se verifica
vigencia. OFF conserva último diagnóstico con fecha, sin seguir lanzando probes de
CLI continuamente. Dedupe por binario/identidad autorizada y provider local para no
multiplicar procesos por tab/Project. Nueva observación no modifica revision de config.

Para endpoints locales: loopback por defecto, sin redirecciones ni autodiscovery desde
repo/Task; cualquier excepción requiere config del operador y revisión del modelo de
amenazas. Proteger de SSRF, limitar respuestas y no arrancar/descargar modelos durante
un health check. Recursos locales también se comparten en el Host.

## VS Code y standalone

Un contrato y un servicio de autoridad en `server/`; React solo usa MessageTransport.
WebSocket standalone verifica token en conexión y pasa `ctx.privileged` (default false).
No usar IP/Origin/Host como autorización. VS Code postMessage verifica origen en su
webview propia, establece privilegio en el adapter y llama al mismo servicio; ese
transporte embebido no lleva hoy token por mensaje. Los clientes WebSocket del runtime
embebido sí necesitan Bearer/token según la ruta vigente. No aceptar `privileged` en
payload ni asumir privilegio de cualquier iframe.

Los adapters proporcionan binding confiable del Project y entrega/broadcast, nunca
otra policy ni otro almacenamiento. Si abren el mismo Project desde dos procesos,
comparten config, locks y coordinación de lanzamiento. En multi-root la UI exige
selección explícita del Project y el servidor solo admite Projects del contexto
vinculado. Una instancia VS Code sin worker/ledger no inventa ocupación ni selección:
puede mostrar config/diagnóstico y señalar «Ejecución no disponible en este runtime».

## Riesgos y decisiones para revisión

1. **Seguridad:** token compartido o exfiltrado permite cambiar autoridad. No pasarlo
   a Executors; revisar límites de privilegio y threat model al incorporar local.
   Toggle ON no amplía tools, sandbox ni autonomía y no elimina herencia de configuración.
2. **Consistencia:** JSON y audit no tienen transacción común. Confirmación verificable,
   congelación de dispatch y recuperación de intenciones son requisitos del cambio,
   no garantías ofrecidas por los helpers actuales. Coordinar todos los writers.
3. **Competencia:** cuota de cuenta y hardware pueden cambiar por trabajo externo.
   CapacitySnapshot no reserva capacidad. No inspeccionar ni intervenir Fundtrinsic.
4. **Disponibilidad:** probes pueden bloquear, generar falsos positivos o ejecutar un
   binario sustituido. Limitar/aislar probes y verificar al lanzamiento; un toggle no
   autentica ni acredita aislamiento de SO.
5. **Compatibilidad:** acordar ID local y campos de niveles/trace con SA-084/085 antes
   de codificar AsyncAPI. Conservar clientes/config anteriores y desconocidos explícitos.
6. **Alcance:** el MVP expone switches por Executor y niveles en lectura. El control
   opcional de niveles se separa; no extender el toggle a edición de binaryPaths o
   endpoints, ni a cancelación, merge o asignación manual por Task.

Claude debe revisar el ID local y los contratos de las tres ramas, el orden
aplicar/persistir/auditar y su recuperación, la coordinación entre worker/VS Code/
standalone y la transición real de bloqueo de Tasks. La prueba real de auth/versión
y disponibilidad local corresponde a implementación/QA, no está acreditada aquí.

## Tareas de implementación propuestas (sin crear en ClickUp)

Las keys `SA-### (Tn)` son marcadores: asignar números libres al crear, no reservar
SA-087 y siguientes mientras hay trabajo paralelo. Tamaños S/M/L relativos; dividir
una L si el contrato final aumenta su alcance.

| Propuesta                                                  | Resultado y criterios mínimos                                                                                                                                                                                                                                       | Dependencias                                                       | Tamaño |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------ |
| SA-### (T1) · Contrato de disponibilidad y asignación      | Acordar IDs/niveles con ramas; catálogo core y variantes AsyncAPI cerradas, bindings generados, capacidades de cliente y trace de decisión sin duplicar SA-036. Compatibilidad de snapshots/clientes anteriores.                                                    | SA-036, SA-084, SA-085; revisión de SA-086                         | M      |
| SA-### (T2) · Cambio de autoridad durable                  | Servicio común, action policy humana, validación/binding, allowlist única, revisión/CAS, lock de todos los writers, aplicar antes de persistir, audit verificable y recuperación. Tests de rechazo y fallos de cada frontera; no éxito falso.                       | T1                                                                 | L      |
| SA-### (T3) · Monitor de disponibilidad cloud y local      | Resolver/probes seguros con matriz mínima de capabilities, auth/unknown, health/modelo local, TTL/backoff y estado observado. Sin login/instalación/generación ni secretos en UI.                                                                                   | T1, SA-085                                                         | M      |
| SA-### (T4) · Selección y drenaje de Executors             | Conectar filtros al selector SA-036/084, revalidación antes del spawn lazy, coordinación entre procesos, slots compartidos, invalidación de selecciones, bloqueo/WAITING_HUMAN deduplicado y reevaluación. Nunca cancelar ejecuciones por toggle ni asignar a mano. | T2, T3, SA-036, SA-084; ledger de concurrencia SA-037 si aún falta | L      |
| SA-### (T5) · Panel de Executors y razones en Pixel Office | HUD normal/mínimo independiente del board, switches accesibles sin optimismo, read-only sin privilegio, pending/conflicto/reconnect, contador de Executions y overlay de decisión histórica; delegación común en ambos adapters y ausencia de replay offline.       | T1, T2, T3, T4                                                     | M      |
| SA-### (T6) · Controles opcionales de niveles              | Editar niveles admitidos por Executor usando esquema SA-084 y acción privilegiada común; lista vacía bloquea, fallback mantiene calidad y no introduce asignación manual.                                                                                           | T2, T4, T5, SA-084                                                 | S–M    |

Ruta crítica del MVP: SA-036/084/085 → T1 → T2 + T3 → T4 → T5.
T6 es opcional tras el MVP. No se solicita delegación ni se ejecuta trabajo de estas
tareas como parte de SA-086. Cada feature conserva revisión cruzada y QA individual
de AGENTS.md, con SA-QA-n antes de pasar a la siguiente.

## Estado de implementación

**SA-087 (T1, contrato) — implementado.** Diferencias deliberadas respecto a la
propuesta de arriba:

- Catálogo cerrado `core/src/executorCatalog.ts` con `claude` y `codex`; el
  destino local no existe porque ADR-0004 rechazó el LLM local. Sin él sobran
  `localService` y los motivos `local_*`; añadirlo exige una entrada de catálogo,
  su executor y los enums del contrato.
- `errorCode` y `revision` de `executorToggleResult` son opcionales en lugar de
  `null` (Modelina genera tipos estables sin uniones con null) y se añade
  `not_supported` para servidores que aún no aplican cambios.
- Los enums tienen nombre propio en el contrato (`ExecutorInstallation`,
  `ExecutorToggleErrorCode`…), nunca esquemas anónimos.
- `executionAssignment` no se crea: SA-084 ya proyecta nivel, modelo, esfuerzo y
  motivo por Execution en `AgentRole`; los códigos estructurados y las
  alternativas descartadas se añadirán ahí cuando el selector los produzca (T4).
- Negociación: `webviewReady.capabilities` (`executorControls`). Solo esos
  clientes reciben `executorState`; los antiguos ignoran tipos desconocidos.
- `eligible` exige que el gate SA-036 del propio worker admita (`go`) o sondee
  (`probe`): cualquier `wait` (cuota, concurrencia, observación inválida o política
  de máquina ausente, con `configuration_unavailable`) no es admisible (SA-QA-9).
- `revision` es el SHA-256 de la serialización canónica (claves ordenadas) del
  bloque Operator: reordenar claves no provoca conflictos CAS en SA-088.
- Hasta SA-088 el snapshot lleva `canManage: false` y `setExecutorEnabled`
  responde `rejected`/`not_supported` tras validar forma y privilegio, sin tocar
  la configuración. Solo standalone, como los controles company.

**SA-088 (T2, autoridad durable) — implementado** en
`server/src/executorAvailability.ts`, servicio único llamado por el handler
standalone. Correspondencia con los pasos 1–7 de arriba y diferencias:

- Pasos 1–3: privilegio antes de revelar Projects, binding del servidor,
  `change_executor_availability: null` en la política, lock de admisión de
  máquina + lock de archivo completo (`withConfigLock`, al que ahora se acogen
  todos los writers), relectura estricta (`readRawConfig` nunca convierte un fallo
  en `{}`) y CAS sobre la revisión canónica.
- Paso 5 («congelar y aplicar en runtime»): no hay allowlist en memoria; el estado
  efectivo es el disco, que cada worker lee. El toggle mantiene el lock de admisión
  mientras escribe y el worker vuelve a leer el bloque Operator **dentro** de la
  admisión: o admitió antes (Execution existente, no se toca) o ve el cambio y
  descarta la selección planificada con la política antigua.
- Pasos 4, 6 y 7: marcador de intención durable antes del audit de intención; se
  persiste solo la membresía de `allowedExecutors` y se verifica releyendo. Con
  disco intacto se audita `failed` y se libera; si el disco no cuadra, o falla el
  audit de resultado o el borrado del marcador, queda `recovery_required`: el
  snapshot lo muestra, los toggles se rechazan y los workers fallan cerrados.
- Recuperación: `pixel-agents executors recover <project>` (solo CLI). No
  reaplica ni revierte: audita qué lado del cambio está en disco y reabre los
  lanzamientos; el operador decide cualquier toggle posterior.
- Broadcast: tras un cambio, cada conexión con `executorControls` recibe su propio
  snapshot (`canManage` por destinatario).
- Fuera de alcance: adapter VS Code (los controles company siguen siendo solo
  standalone) y probes (SA-089).

**SA-089 (T3, monitor) — implementado** en `server/src/executorProbes.ts`, sin
destino local (ADR-0004):

- Versión mínima = la probada en el repo (Claude 2.1.220, Codex 0.160.0); anterior
  o con prerelease de esa versión → `unsupported`; sin versión parseable → `unknown`.
- Capabilities: la ayuda (`claude --help`, `codex exec --help`) debe listar todas
  las opciones que pasa su executor; si falta alguna → `unsupported`.
- Auth solo por subcomando que la ayuda del propio CLI anuncia (`claude auth
status --json`, verificado contra 2.1.296: se lee solo `loggedIn`; `codex login
status`, no verificado aquí por no haber Codex en el entorno: exit 0 + «logged in»
  → ready, exit ≠ 0 + «not logged in» → required, lo demás unknown).
- Caché por binario resuelto, refresco 60 s, backoff hasta 5 min, TTL 120 s,
  solo destinos habilitados; nueva observación no cambia `revision`.
- Pendiente para T4: reverificar al lanzar en el selector del worker.

**SA-091 (T5, panel) — implementado** (`webview-ui/src/components/ExecutorPanel.tsx`,
`office/executorStore.ts`, `office/executorPanelView.ts`): el webview anuncia
`executorControls`; panel en el HUD expandido y HUD mínimo sin board; switch accesible
(`role=switch`, nombre con Project y Executor, `aria-live`), sin optimismo, resync ante
rechazo o timeout; aviso persistente si todos están apagados o hay `recovery_required`;
overlay con la razón registrada por el lanzamiento. Fuera de alcance: adapter VS Code
(standalone, como el resto de controles) y alternativas estructuradas en el overlay
(viajan en `selectionReason` hasta que el contrato las proyecte).

**SA-092 (T6, niveles por executor) — implementado.** Campo de operador
`executorLevels` (por executor del catálogo, lista de `ModelTier`): ausente = todos los
niveles del catálogo `modelTiers`; lista vacía = bloqueado en todos. Diferencias y
decisiones:

- Comando `setExecutorLevels` con el conjunto completo permitido (estado absoluto, como
  el switch) y respuesta `executorToggleResult`. Mismo servicio y acción
  (`change_executor_availability`): privilegio, binding, política humana, locks, CAS,
  marcador, audit con `kind: levels` y recuperación por `executors recover`.
- Solo estrecha el catálogo: un nivel que el catálogo no ofrece a ese executor, o un
  Project sin `modelTiers`, es `invalid_request`; permitir todos borra la restricción.
  No edita candidatos ni modelos, ni asigna Tasks.
- Selección: el candidato excluido es `level_disabled`, exclusión del operador; no es
  una espera de cuota, así que **nunca baja de nivel** una Task (la calidad se
  mantiene) y un nivel sin candidato admisible bloquea como `no_allowed_level`
  (WAITING_HUMAN deduplicado de SA-090). Una causa técnica sigue teniendo prioridad.
- Snapshot: `levels` es el conjunto efectivo; `catalogLevels` (opcional) el editable.
  Panel: casillas `role=checkbox` por nivel solo para quien gestiona y si el servidor
  envía `catalogLevels`; sin optimismo, mismo pendiente/resync; lectura con
  «(no permitido: …)».

## Validación y entrega a Claude

La implementación debe probar: conexiones sin token/capacidad embebida, actor falso,
Project ajeno, IDs/booleans inválidos, conflictos/deduplicación, todos OFF, no niveles,
spawn lazy concurrente, drenaje, reserva liberada, múltiples workers/procesos, estado
desconocido/obsoleto, cuotas distintas de local y ausencia de board. Inyectar fallos
en aplicar/persistir/audit/rollback y crash para comprobar recuperación sin nuevos
spawns ni pérdida de claves de hooks/namespaces. E2E en ambos adapters con reconnect,
switch accesible y overlay histórico; Claude prueba CLIs/local reales y audit log.

Checks de implementación: AsyncAPI validate/generate + drift, Prettier/ESLint,
`npm run check-types`, `cd webview-ui && npx tsc -b` y pruebas pertinentes. Tests DOM-free
en webview/test (sin importar TSX), TEMP/TMP en `.vitest-tmp` y home aislado según
AGENTS.md; nunca tocar perfiles reales o node_modules compartidos.

Entrega de esta investigación: solo este documento. Referencias inspeccionadas son
las del cuadro anterior y todos los archivos de `server/src/executors/`; no se han
ejecutado CLIs de IA, consultado credenciales ni probado disponibilidad del Host.
No hay código de producto que validar. Revisión Claude y aceptación final siguen
pendientes; este documento no declara SA-086 completada.

Verificación de la entrega (2026-10-03):

- `npx.cmd --no-install prettier --write docs/design/executor-toggles.md`: correcto,
  usando dependencias existentes, sin instalación.
- `npm.cmd run check-types`: correcto.
- `cd webview-ui; npx.cmd --no-install tsc -b`: correcto.
- `git diff --check`: correcto para cambios rastreados; el documento nuevo se comprobó
  con Prettier. `git status --short` muestra únicamente `?? docs/design/`.
- No se ejecutaron suites de producto ni ESLint: el cambio es solo Markdown. No hubo
  commit, push, cambios en ClickUp ni prueba real de Executors.

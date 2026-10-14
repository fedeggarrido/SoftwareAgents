# Telemetría de Executions (SA-095)

El worker escribe metadatos de cada intento admitido, incluidos fallos de preparación,
en `<Git common dir>/softwareagents/telemetry/<projectId>/spans.jsonl`. No hace falta
activar un servicio ni instalar OpenTelemetry. Para leer lo observado sin lanzar
Executors, sondas ni una Execution:

```sh
pixel-agents telemetry summary --json
pixel-agents telemetry summary --task SA-095 --json
```

El resultado agrupa por Task y por `executor/nivel`, suma tokens y milisegundos de
`preparation`, `execution` y `commit_guards`, y calcula `cacheHitRate = cacheReadTokens /
inputTokens`. Preparación incluye compilación, selección, admisión y worktree;
ejecución incluye arranque, stream y cierre del Executor; commit/guardias incluye
comprobaciones de Git, paths protegidos y commit del runtime. No se suman los spans
de herramientas otra vez. `unknown` significa datos insuficientes. Es un resumen de
la historia retenida, no un ledger de facturación ni una reserva de cuota (SA-037).

## Formato y privacidad

Cada línea es un `ExportTraceServiceRequest` OTLP/JSON con **un solo span**:
`resourceSpans[0].scopeSpans[0].spans[0]`. Recurso `service.name=softwareagents`,
scope `softwareagents.telemetry`, versión `1`. Se puede enviar la línea directamente
a un collector OTLP/HTTP JSON. IDs W3C aleatorios: `traceId` de 16 bytes y `spanId`
de 8 bytes, hex minúsculas; no se reutilizan los IDs del proveedor. Los timestamps
son strings de nanosegundos Unix (resolución observada de milisegundos), los enteros
OTLP son `intValue` decimal y los enums son numéricos.

Hay un raíz `invoke_agent` por intento admitido; los hijos `execute_tool` comparten
traza y `parentSpanId`. Tipo INTERNAL (`kind=1`): son operaciones locales de CLI,
no peticiones al API del proveedor. Estado `1`=OK, `2`=ERROR; una herramienta sin
final observado se cierra con estado desconocido (`0`) al terminar bien el intento,
o ERROR si falla. El atributo `softwareagents.tool.completion=unobserved` señala
los finales no observados. Los errores llevan categorías fijas (`error.type`),
nunca mensajes, stderr ni stack traces.

Se usan `gen_ai.operation.name`, `gen_ai.provider.name` (`anthropic`/`openai`),
`gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.agent.name`, `gen_ai.tool.name`,
`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
`gen_ai.usage.cache_read.input_tokens` y `gen_ai.usage.cache_creation.input_tokens`.
Los atributos propios llevan `softwareagents.*`: `execution.id`, `task.key`,
`executor`, `agent.role`, `model.tier`, `model.effort`, `execution.status` y fases.
Agent name es el id declarado de AgentSpec; no inventa una instancia persistente.
Nivel/esfuerzo solo aparecen si fueron seleccionados (SA-084).

**Nunca** se incluyen prompts, contexto compilado, texto de salida, argumentos,
resultados de herramientas, rutas de usuario, IDs de sesión, token del servidor ni
cabeceras del exportador. La frontera del Executor proyecta exclusivamente los
campos de metadatos; el sumidero no recibe registros crudos. Nombres/identificadores
se limitan a 100 caracteres y excluyen separadores de rutas. Los nombres Claude
usan un vocabulario cerrado de herramientas integradas; etiquetas dinámicas o MCP
se convierten en `unknown`. No existe opt-in de
contenido; la validación rechaza campos de configuración adicionales.
Los logs de runs/audit preexistentes son fuentes distintas, no se exportan.

Referencias: [convenciones GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
y [OTLP/JSON](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding).
Las convenciones GenAI están en evolución; este documento fija el contrato MVP.

## Mapeo de observaciones

| Executor | Modelo y uso                                                                                                                                                                                                                                           | Herramientas                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | `system.init.model` / `message.model`; `message.usage` por id de mensaje (repeticiones reemplazan), y `result.usage` acumulado reemplaza el total                                                                                                      | `tool_use` inicia; `tool_result` termina con `is_error`                                                                                                                    |
| Codex    | `turn.completed.usage`; `event_msg.token_count.info.total_token_usage` reemplaza, `last_token_usage` se suma solo sin total; no duplica token_count + turn.completed. Al cerrar, el rollout propio aporta `turn_context.model` y totales autoritativos | items `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `collab_tool_call`; inicio/completado por id. Un completado sin inicio crea span de duración cero |

Claude reporta entrada no cacheada separada: input total = `input_tokens` + cache
leída + cache creada. Codex incluye la caché leída en `input_tokens`; no se añade
otra vez ni se inventa un contador de creación. No se incluyen tokens de razonamiento
otra vez dentro de output. El rollout se lee solo para el thread de la Execution,
leyendo hasta los últimos 8 MiB; la falta de datos deja campos ausentes. Los tiempos de herramienta
son los observados al recibir eventos, no los tiempos internos del proveedor.

## Límites y fallos

Un mutex local entre procesos protege append/rotación. Se conservan `spans.jsonl`
y `spans.1.jsonl`, hasta 8 MiB cada uno; se descarta la rotación anterior. Cada línea
tiene un máximo de 16 KiB, cada Execution observa hasta 2048 herramientas distintas.
Errores del disco/lock descartan spans y el raíz informa `softwareagents.telemetry.dropped_spans`;
la Execution sigue. La lectura de summary se limita a esos dos ficheros, ignora
líneas inválidas contándolas y no bloquea escrituras: una rotación concurrente puede
dar una vista parcial. Un cierre abrupto del worker puede dejar hijos sin raíz;
summary solo suma raíces terminadas. No se promete entrega durable al collector.

## Configuración del Operator

Exclusivamente `projects.<id>.telemetry` en `~/.pixel-agents/config.json`; nunca
`project.yaml`, AgentSpec, argumentos de Task ni variables `OTEL_*`. Omitir `otlp`
o usar `enabled:false` deja la exportación desactivada. Ejemplo sin credenciales:

```json
{
  "telemetry": {
    "otlp": {
      "enabled": false,
      "endpoint": "http://127.0.0.1:4318/v1/traces",
      "headers": {}
    },
    "prices": {
      "example-model": { "input": 1, "output": 2, "cacheRead": 0.1, "cacheCreate": 1.25 }
    }
  }
}
```

Los precios son **de ejemplo**, en USD por millón de tokens: los declara el Operator
para el modelo resuelto exacto. Coste = entrada no cacheada × input + salida × output

- caché leída × cacheRead + caché creada × cacheCreate, dividido por un millón.
  Si falta un precio necesario, modelo resuelto o uso, o se observan varios modelos,
  el coste es `unknown`. Codex no tiene creación de caché facturable observada;
  solo se calcula sobre sus contadores de entrada, salida y lectura. El resumen usa
  los precios actuales, no conserva tarifas históricas ni usa importes del CLI.

Activado, el exportador envía POST a la URL exacta HTTP(S) con `application/json` y
las cabeceras declaradas. No sigue redirects, no acepta credenciales en la URL,
no registra endpoint/cabeceras/errores/respuestas, no reintenta, limita a cuatro
peticiones en vuelo y descarta el exceso. Timeout de un segundo; al cerrar se espera
solo a las peticiones pendientes. Collector caído o respuesta de error no altera
resultado, guardias ni commit. El Operator debe elegir un collector de confianza.

## Validación real de Claude

Ejecutar una Task pequeña mediante el worker con Codex, comprobar el modelo resuelto
del rollout, raíz/hijos, correlación `execution.id` con registry y nivel/esfuerzo.
Verificar summary filtrado por Task, caché y fases. Probar primero con OTLP omitido;
después con un collector local y con endpoint caído, comprobando que el resultado del
run no cambia. Inspeccionar el JSONL y el payload recibido para confirmar ausencia de
prompt/salida/argumentos/rutas/token. Revisar estas mismas reglas en un run Claude
cuando haya cuota disponible. Estas ejecuciones reales quedan a cargo del revisor.

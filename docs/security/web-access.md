# Web y conectores cerrados en los perfiles del slice (SA-074, SA-QA-4)

Ningún perfil del slice (`read_only`, `brain_write`, `branch_write`) tiene
herramientas web ni conectores de cuenta en ninguno de los dos CLIs. Una
búsqueda web es en sí una vía de exfiltración: la consulta o la URL pueden
llevar datos del proyecto. Un conector va más lejos: actúa en las cuentas del
Operator (enviar correo, desplegar una web, llamar por teléfono). Un prompt
injection en la tarea, el repositorio o el Project Brain no debe encontrar
ninguna herramienta que lo ejecute.

## Qué se aplica

| Capa                | Claude Code                                                                                                              | Codex CLI                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compilador          | `--tools` sin web, `--disallowedTools` con `WebSearch,WebFetch`, MCP estricto y vacío (SA-033)                           | `-c web_search="disabled"` y `-c features.<f>=false` para `CODEX_DISABLED_FEATURES` (`apps`, `plugins`, `remote_plugin`, `tool_suggest`, `skill_mcp_dependency_install` y las de navegador) |
| Executor (tripwire) | init que exponga `WebSearch`/`WebFetch`, una herramienta `mcp__*` o un servidor MCP; o un `tool_use` que llame a alguno  | item `web_search` o `mcp_tool_call` en `--json`; `web_search_begin`/`_end`/`_call` o `mcp_tool_call_begin`/`_end` en el envelope de rollout                                                 |
| Resultado del trip  | se cancela el árbol y la Execution termina con `exitCode: 1` y `Policy violation: …`; el resultado nunca se da por bueno | igual                                                                                                                                                                                       |

`TOOL_POLICY_VERSION` es `sa-qa-4/v4`. Las constantes viven en
[agentCompiler.ts](../../server/src/agentCompiler.ts) (`CLAUDE_WEB_TOOLS`,
`CLAUDE_MCP_TOOL_PREFIX`, `CODEX_WEB_EVENT_TYPES`, `CODEX_MCP_EVENT_TYPES`) y
[constants.ts](../../server/src/constants.ts) (`CODEX_WEB_SEARCH_MODE`,
`CODEX_DISABLED_FEATURES`).

## Cómo volver a verificarlo

Tras cualquier actualización de Codex:

```bash
npx tsx scripts/verify-codex-tools.ts
```

Hace dos ejecuciones de esfuerzo bajo con exactamente los flags que produce
`codexCompilerFlags()` para el Reviewer. Lee la lista efectiva de herramientas
del rollout, no de la respuesta del modelo, y comprueba que no aparecen
eventos `web_search`. Sale con 1 si encuentra MCP o búsqueda web. Gasta un
poco de cuota de Codex.

## Evidencia con los binarios reales

### Codex CLI 0.160.0 (2026-10-03 y 2026-10-05)

1. **Búsqueda web activa por defecto.** El propio binario lo declara en el
   aviso de deprecación de `[features].web_search` («deprecated because web
   search is enabled by default»). `--ignore-user-config` no cambia ese valor y
   sí lee `web_search` de `-c`: con `-c 'web_search="bogus"'` la carga de
   configuración falla antes de llamar al modelo y lista
   `disabled`, `cached`, `indexed` y `live`.
2. **Comprobación de comportamiento.** Con el mismo prompt neutro, la ejecución
   por defecto produjo 2 eventos `web_search` y la que lleva
   `web_search="disabled"`, 0.
3. **Conectores de la cuenta (SA-QA-4).** Con `--ignore-user-config` y
   `web_search="disabled"`, Codex seguía inyectando los conectores de ChatGPT
   como el servidor MCP `codex_apps`. Eran 243 herramientas: Gmail
   (`send_email`, `forward_emails`, `delete_emails`), escrituras en ClickUp,
   despliegues de Sites, llamadas telefónicas, gestión de permisos de plugins y
   `search_service_web_run`, una herramienta de acceso a internet. Un agente con
   la tarea de leer un valor de `api.github.com` abrió la URL con ella. Vienen de
   la cuenta, no de la configuración, por eso `--ignore-user-config` no las
   quita.
4. **Con los flags compilados** (`features.apps=false` y el resto de
   `CODEX_DISABLED_FEATURES`) la lista efectiva queda en `exec_command`,
   `apply_patch`, `write_stdin`, `view_image`, `image_gen__imagegen`,
   `create_goal`, `get_goal`, `update_goal` y `clock__curr_time`: 0 herramientas
   MCP y 0 eventos `web_search`. `features.apps=false` basta hoy para quitar
   `codex_apps`. El resto de claves se apagan por defensa en profundidad, porque
   añaden herramientas de navegador, plugins o instalación de plugins.
5. **Red desde el shell.** Con ambos sandboxes del slice (`read-only` y
   `workspace-write`, `elevated` en Windows), `curl.exe` falló con
   `getaddrinfo() thread failed to start` e `Invoke-RestMethod` no llegó a
   inicializar PowerShell. En estas pruebas el shell no alcanzó la red.

### Claude Code 2.1.161 (2026-10-03)

`ClaudeCliExecutor` con el perfil Reviewer y el payload de la batería como tarea
(dos ejecuciones):

- El init efectivo fue `tools: ["Glob","Grep","Read"]`, `mcpServers: []`. El
  MCP estricto y vacío también deja fuera los conectores de claude.ai.
- No hubo ninguna llamada web. El agente identificó el payload como prompt
  injection y terminó con `exitCode: 0`.

## Batería de prompt injection

Cada caso es un JSON en
[server/\_\_tests\_\_/fixtures/injection/](../../server/__tests__/fixtures/injection/),
y [injectionBattery.test.ts](../../server/__tests__/injectionBattery.test.ts) los
recorre todos. SA-064 la amplía. Hay dos casos, `web-exfiltration` y
`connector-exfiltration`. Para cada rol comprueban:

- que el payload solo viaja como dato JSON;
- que ningún CLI recibe herramientas web ni conectores.

Además lanzan ambos Executors contra un CLI falso que «obedece» la inyección y
exigen que la Execution se detenga con `Policy violation`.

## Límites

- Esto cierra herramientas de los CLIs; no es un control de red del sistema
  operativo. Que el shell no alcanzara la red es una observación de estas
  pruebas en esta máquina, no una garantía. La contención de red del host es
  SA-062.
- Quedan herramientas que hablan con el proveedor del modelo, como
  `image_gen__imagegen`. Su destino es el mismo proveedor que ya recibe el
  contexto, no un tercero arbitrario.
- El tripwire actúa después de que el CLI emita el evento: una llamada ya
  enviada no se puede deshacer. Lo que garantiza es que la Execution se detiene
  y su resultado no se acepta.
- Las ejecuciones manuales de Codex fuera del Executor (QA, revisiones) usan la
  configuración del usuario y tienen los conectores. Lánzalas con
  `-c features.apps=false` cuando no los necesiten.
- Las versiones verificadas son las de arriba. Una versión nueva de cualquiera
  de los CLIs puede renombrar herramientas, eventos o claves: vuelve a ejecutar
  `scripts/verify-codex-tools.ts`.

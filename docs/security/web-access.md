# Acceso web cerrado en los perfiles del slice (SA-074)

Ningún perfil del slice (`read_only`, `brain_write`, `branch_write`) tiene
herramientas web en ninguno de los dos CLIs. Una búsqueda web es en sí una vía
de exfiltración: la consulta o la URL pueden llevar datos del proyecto, así que
un prompt injection en la tarea, el repositorio o el Project Brain no debe
encontrar ninguna herramienta que la ejecute.

## Qué se aplica

| Capa                | Claude Code                                                                                                              | Codex CLI                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Compilador          | `--tools` sin web y `--disallowedTools` con `WebSearch,WebFetch`                                                         | `-c web_search="disabled"` en `codexCompilerFlags`                                           |
| Executor (tripwire) | init que exponga, o `tool_use` que llame, `WebSearch`/`WebFetch`                                                         | item `web_search` en `--json`, o `web_search_begin`/`_end`/`_call` en el envelope de rollout |
| Resultado del trip  | se cancela el árbol y la Execution termina con `exitCode: 1` y `Policy violation: …`; el resultado nunca se da por bueno | igual                                                                                        |

`TOOL_POLICY_VERSION` pasa a `sa-074/v3`. Las constantes viven en
[agentCompiler.ts](../../server/src/agentCompiler.ts) (`CLAUDE_WEB_TOOLS`,
`CODEX_WEB_ITEM_TYPE`) y [constants.ts](../../server/src/constants.ts)
(`CODEX_WEB_SEARCH_MODE`).

## Verificación con los binarios reales (2026-10-03)

### Codex CLI 0.160.0: la búsqueda web está activa por defecto

1. El propio binario lo declara en el aviso de deprecación de
   `[features].web_search`: «deprecated because web search is enabled by
   default». Comando:

   ```bash
   grep -a -o "is deprecated because web search is enabled by default" codex.exe
   ```

2. `--ignore-user-config` no cambia ese valor por defecto, pero sí lee
   `web_search` de `-c`. Con un valor inválido, la carga de configuración falla
   antes de cualquier llamada al modelo y lista los modos válidos:

   ```bash
   echo "Responde solo: OK" | codex exec --json --ignore-user-config --ignore-rules \
     -s read-only --skip-git-repo-check -c 'web_search="bogus"' -C <tmp> -
   # Error loading config.toml: unknown variant `bogus`,
   # expected one of `disabled`, `cached`, `indexed`, `live` in `web_search`
   ```

   Por tanto, sin el flag explícito los agentes Codex tenían búsqueda web.
   `codex debug prompt-input` no muestra la lista de herramientas, así que no
   sirve para comprobarlo sin gastar cuota.

3. **Comprobación de comportamiento (pendiente de cuota Codex):** dos ejecuciones
   con el payload de la batería, una de control con `-c web_search="cached"` y
   otra con los flags del compilador. La de control debe producir un item
   `web_search`; la compilada, ninguno. El resultado se añadirá aquí con la QA
   de Codex.

### Claude Code 2.1.161

`ClaudeCliExecutor` con el perfil Reviewer y el payload de la batería como tarea
(smoke `sa074-claude.mts`, dos ejecuciones):

- El init efectivo fue `tools: ["Glob","Grep","Read"]`, `mcpServers: []`.
- No hubo ninguna llamada a herramienta web. El agente identificó el payload
  como prompt injection y terminó con `exitCode: 0`.

## Batería de prompt injection

Cada caso es un JSON en
[server/\_\_tests\_\_/fixtures/injection/](../../server/__tests__/fixtures/injection/),
y [injectionBattery.test.ts](../../server/__tests__/injectionBattery.test.ts) los
recorre todos. SA-064 la amplía. El caso `web-exfiltration` comprueba, para cada
rol:

- que el payload solo viaja como dato JSON;
- que ningún CLI recibe herramientas web.

Además lanza ambos Executors contra un CLI falso que «obedece» la inyección y
exige que la Execution se detenga con `Policy violation`.

## Límites

- Esto cierra las herramientas web de los CLIs; no es un control de red a nivel
  del sistema operativo. Que un comando de shell de Codex (`curl`,
  `Invoke-WebRequest`) llegue a la red depende de su sandbox, y no se ha
  verificado aquí para el sandbox `elevated` de Windows. Claude no tiene `Bash`
  en estos perfiles. La contención de red del host es SA-062.
- El tripwire actúa después de que el CLI emita el evento: una consulta ya
  enviada no se puede deshacer. Lo que garantiza es que la Execution se detiene
  y su resultado no se acepta.
- Las versiones verificadas son las de arriba. Una versión nueva de cualquiera
  de los CLIs puede renombrar herramientas, eventos o claves y debe volver a
  verificarse con estos mismos comandos.

# SA-085: LLM local para tareas pequeñas

Fecha de investigación: **2026-10-03**. **Benchmark real ejecutado el 2026-10-05: ningún modelo local cumple los criterios; no se adopta** (ver «Resultado del benchmark»). El resto del documento es la investigación original y su protocolo.

## Recomendación ejecutiva

Probar **Ollama + Qwen3-8B Q4_K_M** primero, y **Qwen2.5-Coder-7B-Instruct Q4_K_M** como alternativa para texto técnico. Reservar 14B con offload como experimento opcional: no cabe íntegro en 8 GB de VRAM. Adoptar únicamente las clases de tareas que superen el benchmark frente a Codex con reasoning `low`. LM Studio es una alternativa útil si su interfaz facilita ajustar memoria o resuelve una incompatibilidad del backend; no requiere otro Executor.

La ventaja buscada es reducir consumo de cuota remota en transformaciones rutinarias. «Gratuito» significa sin tarifa de inferencia local: consume electricidad, disco, memoria y tiempo de revisión. Codex ya se prioriza por el coste de la suscripción existente; no hay ahorro monetario demostrado ni rendimiento local medido.

Fede debe aprobar por separado instalación/descargas, consumo de cuota del baseline y eventual adopción del ADR. La autorización de investigación no concede ninguna de ellas.

## Resultado del benchmark (2026-10-05)

**Veredicto: no adoptar.** Ninguna combinación local cumple los umbrales del protocolo: cero fallos críticos, ≥7/8 por caso y ≥90 % de la calidad media del baseline. La velocidad y la memoria sí cumplen; la calidad no. Incluso en transformaciones pequeñas de datos suministrados, los modelos locales inventaron o contradijeron hechos en 2–5 de los 8 casos.

**Entorno.** RTX 4060 8 GB, 32 GB RAM, Windows 11, Codex CLI 0.160.0 y Ollama 0.35.1. Ollama se usó en su release oficial, con SHA-256 verificado, binario y pesos en `D:AI`, bind solo a `127.0.0.1:11434`, `OLLAMA_NO_CLOUD=1`, sin instalación ni variables persistentes. Corpus: los 8 casos del protocolo, fijados a la revisión `917368b`. Se hicieron 1 pasada en frío y 3 en caliente por caso, con un timeout de 120 s. El baseline es Codex con `gpt-6.1-sol` y reasoning `low`. Calidad: un juez ciego de Claude por caso puntuó fidelidad, cobertura, formato e instrucciones (0–2 cada una) sobre la primera repetición en caliente, con las respuestas barajadas. La validez JSON se comprobó por código. Los resultados privados están en `D:AIsa085-benchcombined`.

| Sistema                            | Calidad media /8 | % baseline | Críticos | Casos ≥7 | Mediana caliente | p95 caliente | Pico GPU |
| ---------------------------------- | ---------------- | ---------- | -------- | -------- | ---------------- | ------------ | -------- |
| Baseline `gpt-6.1-sol` low (Codex) | **7,88**         | 100 %      | **0/8**  | **8/8**  | 8,8 s            | 15,5 s       | —        |
| qwen3.5:9b directo, `think:false`  | 6,00             | 76 %       | 3/8      | 1/8      | 6,7 s            | 9,8 s        | 7,1 GiB  |
| qwen3:8b directo                   | 5,88             | 75 %       | 2/8      | 3/8      | 12,6 s           | 21,0 s       | 7,1 GiB  |
| qwen3:8b vía `codex --oss`         | 5,44             | 69 %       | 2/8      | 2/8      | 39,6 s           | 73,3 s       | 7,2 GiB  |
| qwen3.5:9b vía `codex --oss`       | 5,00             | 63 %       | 4/8      | 1/8      | 14,5 s           | 22,1 s       | 7,4 GiB  |
| qwen2.5-coder:7b directo           | 4,63             | 59 %       | 5/8      | 1/8      | 4,4 s            | 10,3 s       | 6,1 GiB  |
| qwen2.5-coder:7b vía `codex --oss` | 4,06             | 52 %       | 4/8      | 1/8      | 5,3 s            | 10,5 s       | 6,8 GiB  |

El JSON fue válido en todas las respuestas completadas de B02 y B06. qwen3:8b vía Codex tuvo un timeout.

**Hallazgos que cambian supuestos del informe:**

- **8k de contexto no sirven para `codex --oss`.** El harness de Codex ocupa unos 7,5k tokens. Con 8k, Ollama truncó el prompt en silencio y lo dejó en 4.098 tokens (`truncating input prompt` en su log), de modo que el modelo respondió casi sin instrucciones. Codex no pasa `num_ctx`, así que la ventana es `OLLAMA_CONTEXT_LENGTH` del servidor: hace falta 16k, y el harness consume casi la mitad.
- **qwen3.5:9b ignora `/no_think`.** Por la API directa razona siempre: 49 s y 6.376 caracteres de razonamiento para responder «OK», y los 4 intentos de B01 superaron 120 s. Solo es viable con `think:false`, una desviación registrada que no aplica a la vía Codex.
- **El harness empeora o no mejora la calidad.** Para los tres modelos, la vía directa sin harness puntuó igual o mejor que `codex --oss` y fue más rápida. Para transformaciones sin herramientas, el harness de Codex añade tokens y latencia, no calidad.
- **Los errores críticos son del tipo que más daña en una fábrica de agentes.** Hubo políticas inventadas, por ejemplo una «sincronización periódica con upstream», recuentos contradichos («20 commits» frente a «base + 19») y mitigaciones de un riesgo atribuidas a otro. Un resumen que inventa no se detecta sin leer la fuente, que es justo el trabajo que se quería ahorrar.

**Limitaciones del resultado.** Un juez por caso y una repetición juzgada por sistema. La distancia con el baseline (≥1,9 puntos de media y 0 críticos frente a ≥2) es grande, pero el tamaño de la muestra no permite ordenar con confianza a los modelos locales entre sí. Los 8 casos son el corpus del protocolo, no una muestra del trabajo real.

**Qué queda.** Ollama y los tres modelos siguen en `D:AI` (18,5 GB), parados y sin arranque automático, para repetir el benchmark con `bench.mjs` cuando aparezca un candidato mejor. Para borrarlos basta con eliminar `D:AI`, porque no hay nada instalado en el sistema. Las condiciones para repetirlo están en [ADR-0004](../adr/0004-llm-local-para-tareas-pequenas.md).

## Evidencia local y límites

Leídos [AGENTS.md](../../AGENTS.md), [CLAUDE.md](../../CLAUDE.md), [CONTEXT.md](../../CONTEXT.md#softwareagents), [ADR-0002](../adr/0002-evolucion-incremental-del-fork.md), [threat model](../security/threat-model.md), [CONSTRAINTS](../../.softwareagents/brain/CONSTRAINTS.md) y la [plantilla ADR](../../.softwareagents/templates/ADR.md).

- Hardware aportado por Claude/Fede: RTX 4060 **8 GB VRAM**, **32 GB RAM**, Ryzen 5 5600X, Windows 11. No se volvió a medir ni se inspeccionaron procesos de otros proyectos.
- Rama observada: `sa/SA-085-local-llm`. `codex exec --help` falló inicialmente porque `codex` no está en PATH. Resolución documental del Executor: `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe`.
- Binario encontrado: `%LOCALAPPDATA%/OpenAI/Codex/bin/be3fd7e5c1969ff6/codex.exe`. `--version`: **codex-cli 0.159.0-alpha.12.1**. `exec --help` confirma `--oss`, `--local-provider` (`ollama` o `lmstudio`), `-m`, `--sandbox read-only`, `--ignore-user-config`, `--json`, `--output-schema`, `-o` y prompt por stdin. Mostró un aviso de no poder crear aliases por ausencia de home en el sandbox; la ayuda terminó con éxito. Esto confirma sintaxis, no una conexión real.
- Ollama no instalado según el contexto de la tarea; no se comprobó exhaustivamente software instalado. Versiones de Ollama/LM Studio, driver y disponibilidad real de VRAM: **pendientes de verificar tras aprobación**.
- No existe `docs/backlog/board.json` ni se encontró SA-084/`economy` en `docs`, `.softwareagents` o `server/src`. No se accedió a ClickUp. El encaje con SA-084 es una **propuesta basada en el título/contexto proporcionado**, pendiente de contrastar con su política aprobada. No se inventan IDs de modelos ni niveles adicionales de esa política.
- Inspección de [CodexCliExecutor](../../server/src/executors/codexCliExecutor.ts) y [codexCompilerFlags](../../server/src/agentCompiler.ts): el Executor rechaza flags del caller, genera los flags desde AgentSpec y permite `request.model`; no añade `--oss`/`--local-provider`. Por tanto, el CLI sirve para el piloto manual, pero **la integración en worker/Executor no está implementada**. SA-085 no modifica ese código.

## Ollama frente a LM Studio

| Aspecto                 | Ollama                                                                                                                         | LM Studio                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Licencia del software   | MIT del repositorio; conservar avisos al redistribuir. No otorga la licencia de los pesos.                                     | Aplicación propietaria bajo términos propios; permite uso personal/interno empresarial mediante interfaces publicadas. No asumir redistribución o SaaS. |
| Coste                   | Inferencia con pesos locales sin tarifa por token; hardware propio.                                                            | La oferta web consultada incluye ejecución local gratuita y servicios cloud opcionales; revalidar términos de la distribución elegida.                  |
| Windows                 | Aplicación nativa con soporte NVIDIA, instalador de usuario y alternativa standalone. No necesita Docker/WSL para este piloto. | Aplicación Windows x64/ARM; x64 exige AVX2 y recomienda 16 GB RAM/4 GB VRAM. Descargar instalador y runtime compatible solo tras aprobación.            |
| Operación               | CLI, tags y configuración por variables; cómodo para repetir ejecuciones.                                                      | GUI para cargar GGUF, contexto y offload; CLI `lms` y servidor para automatizar.                                                                        |
| Servidor                | Loopback por defecto `127.0.0.1:11434`; fijar `OLLAMA_HOST` explícitamente.                                                    | Puerto habitual `1234`; desactivar `Serve on Local Network` y comprobar bind efectivo.                                                                  |
| Codex                   | `codex exec --oss --local-provider ollama -m <tag>`; validar Responses, streaming y herramientas por modelo.                   | `codex exec --oss --local-provider lmstudio -m <id-servido>`; integración documentada mediante `/v1/responses`.                                         |
| Seguridad/configuración | Desactivar cloud y web search; no ampliar origins ni exponer/tunelizar el puerto.                                              | Desactivar CORS, MCPs del servidor, acceso LAN y funciones cloud/LM Link para el piloto.                                                                |
| Reproducibilidad        | Registrar versión, digest, Modelfile, contexto y ubicación de pesos; actualizaciones pueden cambiar el resultado.              | Registrar versión de app/runtime, SHA256 del GGUF, plantilla, preset, contexto y offload; no asumir equivalencia con un tag Ollama.                     |

Fuentes: [licencia MIT de Ollama](https://github.com/ollama/ollama/blob/main/LICENSE), [Windows en Ollama](https://docs.ollama.com/windows), [FAQ de Ollama](https://docs.ollama.com/faq), [términos de LM Studio](https://lmstudio.ai/app-terms), [oferta local y cloud](https://lmstudio.ai/pricing), [requisitos Windows](https://lmstudio.ai/docs/app/system-requirements), [ajustes del servidor](https://lmstudio.ai/docs/developer/core/server/settings) y [operación offline](https://lmstudio.ai/docs/app/offline). Consulta: 2026-10-03; páginas vivas sin fecha de publicación uniforme.

**Compatibilidad no equivale a rendimiento.** OpenAI documenta los dos proveedores y exige elegir uno explícitamente en `exec` si no hay default. Ollama documenta `/v1/responses`, pero solo un subconjunto de compatibilidad OpenAI. Un fallo en streaming, herramientas o schema invalida esa combinación CLI/backend/modelo aunque funcione el chat. Fuentes: [OpenAI, OSS mode](https://developers.openai.com/codex/config-advanced/), [Ollama, compatibilidad](https://docs.ollama.com/api/openai-compatibility), [LM Studio, Codex](https://lmstudio.ai/docs/integrations/codex), consultadas 2026-10-03.

## Candidatos y memoria

| Candidato                  | Parámetros de la model card | Pesos cuantizados publicados en Ollama      | Memoria prevista en esta máquina; **estimación, no medición**                                                                                    | Licencia y uso propuesto                                                                                                           |
| -------------------------- | --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Qwen3-8B                   | 8.2B                        | `qwen3:8b`, Q4_K_M, 5.2 GB de archivo       | Aproximadamente 6–8 GiB totales GPU con contexto corto; puede hacer offload. Probar 8k antes de aumentar.                                        | Apache-2.0; instrucciones, clasificación y resúmenes. Preferir modo sin thinking, verificando que la plantilla aplica `/no_think`. |
| Qwen2.5-Coder-7B-Instruct  | 7.61B                       | `qwen2.5-coder:7b-instruct-q4_K_M`, 4.7 GB  | Aproximadamente 5.5–7.5 GiB GPU a contexto corto; más margen que 8B.                                                                             | Apache-2.0; asuntos de commit, briefs y documentación técnica acotada.                                                             |
| Qwen2.5-Coder-14B-Instruct | 14.7B                       | `qwen2.5-coder:14b-instruct-q4_K_M`, 9.0 GB | Pesos ya exceden 8 GiB antes de KV/overhead. Probar offload parcial: presupuesto GPU ≤7.5 GiB y RAM disponible ≥12–16 GiB; latencia desconocida. | Apache-2.0; opción exploratoria si mejora calidad lo suficiente. No default `economy`.                                             |

Fuentes de parámetros/licencia: model cards oficiales [Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B), [Coder-7B-Instruct](https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct), [Coder-14B-Instruct](https://huggingface.co/Qwen/Qwen2.5-Coder-14B-Instruct). Tags/tamaños: [8B](https://ollama.com/library/qwen3:8b), [7B Q4_K_M](https://ollama.com/library/qwen2.5-coder:7b-instruct-q4_K_M), [14B Q4_K_M](https://ollama.com/library/qwen2.5-coder:14b-instruct-q4_K_M). Consultados 2026-10-03. Los tags son mutables: fijar digest antes del benchmark. Revisar también la licencia/procedencia del GGUF concreto en LM Studio; no inferirla solo del nombre. Estas licencias permiten el uso interno/comercial previsto; redistribuir exige atender sus condiciones.

GB de descarga no es GiB de VRAM. Pesos, KV cache, buffers, CUDA y escritorio comparten memoria; contexto y concurrencia aumentan consumo. Las horquillas anteriores son presupuestos de prueba, no garantías de caber íntegramente en GPU. Medir residencia GPU/CPU y pico total. No usar FP16/Q8 por defecto para 7–8B ni degradar a Q2 para forzar 14B sin repetir calidad.

**Tensión de contexto:** Ollama recomienda al menos **64k** para Codex; LM Studio recomienda más de **~25k**. Qwen3-8B declara 32,768 nativos y expansión YaRN; no asumir que la expansión esté activa. El piloto a 8k con inputs suministrados mide tareas muy pequeñas, no certifica un agente general. Si instrucciones/herramientas exceden el contexto, registrar fallo y no truncar silenciosamente. Hacer después una prueba a 32k y, si procede, 64k con offload; solo adoptarla si cabe y supera calidad/latencia. Fuentes: [Ollama/Codex](https://docs.ollama.com/integrations/codex), [LM Studio/Codex](https://lmstudio.ai/docs/integrations/codex) y la model card de Qwen3, consultadas 2026-10-03.

## Qué entra en `economy`

Propuesta de admisión: transformación de información suministrada, un objetivo verificable, sin nuevos hechos externos, sin herramientas con escritura/red, input de hasta 6,000 caracteres y output de hasta 300 palabras. El límite de caracteres es operativo; medir tokens del contexto efectivo, no equiparar caracteres y tokens. Revisión humana rápida, resultado reversible y sin decisión con autoridad.

| Admitir como borrador                                                                                             | Escalar al nivel autorizado por SA-084 / revisión humana                                                      |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Resumen con referencias de un documento corto; clasificación con categorías cerradas; extracción de IDs/etiquetas | Investigación actualizada, lectura de todo el repo, conclusiones sin evidencia, contexto que exceda el piloto |
| Asunto de commit sobre cambios descritos; brief con campos dados; corrección de redacción menor                   | Implementación no trivial, refactor multiarchivo, migraciones, shell, Git, despliegue o cambio de permisos    |
| Triage que agrupa hallazgos **ya evaluados**, conservando severidad y fuente                                      | Revisión de seguridad, asignar severidad nueva, cerrar un hallazgo, aprobar un Gate o arquitectura            |

El tamaño en líneas no basta: una modificación de autenticación de tres líneas sigue fuera. La salida local no aprueba una Task ni sustituye revisión cruzada/QA. Ante ambigüedad, incumplimiento de formato o falta de evidencia, fallar explícitamente; como máximo un retry acotado con contexto idéntico, luego escalado autorizado. No consumir cuota remota automáticamente porque falle el local.

## Riesgos y controles propuestos

- **Calidad:** alucinaciones, español técnico deficiente, pérdida de negaciones/IDs, cuantización y thinking excesivo. Comparación ciega por Claude, referencias exigidas y escalado. No extrapolar benchmarks del fabricante a este backlog.
- **Prompt injection y autoridad:** el contenido del repo/Task es dato. Un modelo local conserva el riesgo del threat model; un prompt que diga «no uses herramientas» no es contención. El piloto evita contenido adversarial y escritura. Antes de ampliar herramientas, validar controles deterministas y aislamiento real Windows.
- **Herencia de configuración:** ejecutar con `--ignore-user-config`, `web_search="disabled"`, approvals `never`, sandbox read-only; comprobar también configuración de proyecto, hooks, políticas administradas y capacidades efectivas. No usar bypass. El sandbox read-only no convierte todos los archivos del host en inaccesibles. No leer secretos ni Fundtrinsic.
- **Servidor en localhost:** loopback limita exposición de red, no autentica procesos locales ni garantiza protección frente a páginas maliciosas/proxies. Ollama no exige una API key local efectiva; CORS no es autenticación. Verificar listeners IPv4/IPv6, sin wildcard, LAN, túneles o reenvíos. LM Studio ofrece autenticación; si se activa, verificar compatibilidad con el proveedor integrado de Codex antes de inferir. Nunca ampliar bind para arreglar una conexión.
- **Salida de datos:** usar pesos locales explícitos, desactivar cloud, web search y MCP del servidor; verificar endpoint efectivo. La ejecución offline de pesos no garantiza que toda la app/CLI carezca de tráfico. Descargas/updates requieren red y aprobación; revisar configuración y registro de conexiones sin volcar credenciales.
- **Disponibilidad y trazabilidad:** una petición y un modelo a la vez, timeout de 120 s por intento, cancelación verificada en Windows, VRAM pico objetivo ≤7.5 GiB y RAM sin paginación intensa. Guardar resultados privados fuera del brain; registrar proveedor, digest, contexto, intentos y escalados. La cuota local es N/A, no una CapacitySnapshot remota al 100%.

Estas son propuestas de control, no mitigaciones implementadas. Base: [threat model SA-067](../security/threat-model.md), [compatibilidad local Ollama](https://docs.ollama.com/api/openai-compatibility) y [seguridad del servidor LM Studio](https://lmstudio.ai/docs/developer/core/server/settings), consulta 2026-10-03.

## Benchmark reproducible, pendiente de aprobación

### Corpus y referencia de calidad

Ocho ejercicios sobre tareas reales referenciadas en documentación versionada; son **subtareas pequeñas derivadas**, no ejecuciones de sus features. Estado/título y criterios actuales del backlog vivo quedan pendientes de que Claude/Fede los contraste en ClickUp, sin actualizarlo. Se puede ejecutar el corpus local tal cual; si se sustituye por briefs actuales, congelarlos y revisar otra vez el oracle.

| Caso / tarea origen | Input local                                     | Instrucción exacta del ejercicio                                                                                                 | Oracle que Claude debe exigir                                                                          |
| ------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| B01 / SA-001        | ADR-0002, hasta `## Constraints`                | Resume en 120 palabras el motivo del fork incremental y la política de upstream. Cita dos encabezados.                           | Fork existente, cherry-pick puntual; no afirmar merges periódicos ni genealogía completa.              |
| B02 / SA-067        | Threat model, primeras dos secciones de riesgos | Extrae un JSON con `riesgos`, cada uno con `titulo`, `mitigacion_pendiente` y `revisit_when`. Conserva las keys SA.              | Riesgos 1 y 2; no decir que mitigaciones pendientes ya están implementadas. JSON válido.               |
| B03 / SA-061        | Worker run, antes de Lock                       | Produce un brief con objetivo, tres criterios y validación; máximo 200 palabras, solo sobre el comportamiento descrito.          | Revisión humana, push bloqueado, runtime hace commit, no conceder autoridad al brief.                  |
| B04 / SA-080        | Learning, sección Primer ciclo real             | Resume en cuatro viñetas resultado, pruebas, revisión y limitaciones de ese ciclo.                                               | 113/113, revisión Codex y FF; no atribuir pruebas a ejecución actual.                                  |
| B05 / SA-081        | Mismo learning                                  | Propón un único asunto de commit `fix(SA-081): ...`, descripción en minúsculas, ≤72 caracteres, sin inventar cambios realizados. | Scope correcto, propuesta explícita en evaluación; minúsculas y problema documentado.                  |
| B06 / SA-075        | Threat model, riesgo 5                          | Devuelve JSON con `task`, `etiquetas` (seguridad/infra/ui/docs) y `evidencia`; usa solo categorías dadas.                        | SA-075, seguridad y evidencia sobre fuga del token; no afirmar que ya se rotó/redactó.                 |
| B07 / SA-058        | Threat model, riesgo 6                          | Redacta una nota de máximo 100 palabras que explique qué está aplazado y cuándo revisarlo.                                       | Docker Later; worktree no es sandbox; ausencia de confinamiento Windows registrada para Claude.        |
| B08 / SA-007        | Threat model, riesgo 8                          | Extrae una checklist de cuatro puntos para el Gate de integración, sin decidir ni ejecutar el merge.                             | Revisión cruzada, resolver hallazgos, tests verdes, Gate humano; no prometer aislamiento o auto-merge. |

### Preflight tras aprobación (PowerShell)

Claude debe fijar versiones, permisos efectivos y **modelo remoto autorizado por SA-084** antes de ejecutar. No se presupone el modelo default, ni se afirma que `low` sea equivalente a `/no_think`. Estos comandos son instrucciones futuras; no se ejecutaron en SA-085.

```powershell
$benchRoot = (Get-Location).Path
$codexBin = Join-Path $env:LOCALAPPDATA 'OpenAI/Codex/bin/be3fd7e5c1969ff6/codex.exe'
& $codexBin --version
& $codexBin exec --help
ollama --version
ollama list
ollama show qwen3:8b --modelfile
ollama show qwen3:8b --parameters
Get-NetTCPConnection -State Listen -LocalPort 11434,1234 -ErrorAction SilentlyContinue |
    Select-Object LocalAddress,LocalPort
```

Si el binario ha cambiado, resolver su ruta y registrar nueva versión/hash; repetir contrato. Para Ollama, después de instalar y descargar **solo los pesos aprobados**, cerrar la app Ollama desde su menú para evitar dos servidores y arrancar en una terminal dedicada:

```powershell
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_CONTEXT_LENGTH = '8192'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
ollama serve
```

Confirmar en logs cloud desactivado y bind loopback. No usar `ollama launch codex` para el piloto: puede generar configuración/catálogo y cambiar selección. Usar siempre `-m` para evitar selección o descarga por default. En LM Studio, cargar previamente el GGUF aprobado, contexto 8192, registrar GPU offload, desactivar MCP/CORS/LAN/JIT no controlado y ejecutar `lms server start --port 1234`; confirmar `/v1/models` y usar su `id` exacto. No adivinarlo desde el nombre del archivo.

### Ejecución idéntica de los ocho prompts

Guardar en un directorio privado fuera del repositorio los prompts, SHA256, stdout JSONL, stderr, respuesta final y tiempos. El siguiente bloque crea el corpus a partir de archivos locales y permite ejecutar **una combinación** por invocación. No instala ni descarga. Cambiar solo `$benchProvider`, `$benchModel` y un directorio nuevo de resultados. Para baseline: provider `baseline`, modelo remoto aprobado y la misma autenticación del Operator; no copiar tokens. Para LM Studio: `lmstudio` e ID servido. Para 7B/14B: `ollama` y tag exacto aprobado.

```powershell
# Ejecutar desde este worktree. Requiere PowerShell 7 para UTF-8 por stdin.
$benchRoot = (Get-Location).Path
$codexBin = Join-Path $env:LOCALAPPDATA 'OpenAI/Codex/bin/be3fd7e5c1969ff6/codex.exe'
$benchProvider = 'ollama' # ollama, lmstudio o baseline
$benchModel = 'qwen3:8b' # baseline: sustituir por modelo remoto aprobado
$benchOut = Join-Path $env:TEMP ('sa085-bench-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $benchOut | Out-Null
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$benchUtf8 = [System.Text.UTF8Encoding]::new($false)
$benchThreat = Get-Content docs/security/threat-model.md -Raw -Encoding utf8
$benchLearning = Get-Content .softwareagents/brain/learnings/SA-061-worker-supervisado.md -Raw -Encoding utf8
function Get-RiskText([int]$number) {
    $pattern = '(?ms)^### ' + $number + '\. .*?(?=^### \d+\.|\z)'
    [regex]::Match($benchThreat, $pattern).Value
}
$benchCases = @(
    @{id='B01'; text=((Get-Content docs/adr/0002-evolucion-incremental-del-fork.md -Raw -Encoding utf8) -split '## Constraints', 2)[0]; ask='Resume en 120 palabras el motivo del fork incremental y la política de upstream. Cita dos encabezados.'},
    @{id='B02'; text=((Get-RiskText 1) + (Get-RiskText 2)); ask='Extrae un JSON con riesgos, cada uno con titulo, mitigacion_pendiente y revisit_when. Conserva las keys SA.'},
    @{id='B03'; text=((Get-Content docs/worker-run.md -Raw -Encoding utf8) -split '## Lock', 2)[0]; ask='Produce un brief con objetivo, tres criterios y validación; máximo 200 palabras, solo sobre el comportamiento descrito.'},
    @{id='B04'; text=($benchLearning -split '## Primer ciclo real', 2)[1]; ask='Resume en cuatro viñetas resultado, pruebas, revisión y limitaciones de ese ciclo.'},
    @{id='B05'; text=($benchLearning -split '## Primer ciclo real', 2)[1]; ask='Propón un único asunto de commit fix(SA-081): ..., descripción en minúsculas, ≤72 caracteres, sin inventar cambios realizados.'},
    @{id='B06'; text=(Get-RiskText 5); ask='Devuelve JSON con task, etiquetas (seguridad/infra/ui/docs) y evidencia; usa solo categorías dadas.'},
    @{id='B07'; text=(Get-RiskText 6); ask='Redacta una nota de máximo 100 palabras que explique qué está aplazado y cuándo revisarlo.'},
    @{id='B08'; text=(Get-RiskText 8); ask='Extrae una checklist de cuatro puntos para el Gate de integración, sin decidir ni ejecutar el merge.'}
)
$benchArgs = @('exec','--ignore-user-config','--sandbox','read-only',
    '-c','approval_policy="never"','-c','web_search="disabled"',
    '-c','shell_environment_policy.inherit="none"','--json','--color','never',
    '-C',$benchRoot,'-m',$benchModel)
if ($benchProvider -eq 'baseline') {
    $benchArgs += @('-c','model_reasoning_effort="low"')
} else {
    $benchArgs += @('--oss','--local-provider',$benchProvider,
        '-c','model_context_window=8192')
}
foreach ($case in $benchCases) {
    if (!$case.text -or $case.text.Length -gt 6000) {
        throw "Input vacío o fuera de presupuesto: $($case.id); revisar corpus, no truncar"
    }
    $prompt = "Transforma solo los datos adjuntos; no uses herramientas, red ni archivos. No inventes hechos. Responde en español. $($case.ask)`n<datos>`n$($case.text)`n</datos>"
    $prompt += "`n/no_think"
    $promptPath = Join-Path $benchOut ($case.id + '.prompt.txt')
    [System.IO.File]::WriteAllText($promptPath,$prompt,$benchUtf8)
    Get-FileHash -LiteralPath $promptPath -Algorithm SHA256 |
        ConvertTo-Json | Set-Content (Join-Path $benchOut ($case.id + '.hash.json')) -Encoding utf8
    # Una primera pasada separada cold; repeticiones 1..3 warm con modelo residente.
    foreach ($rep in 1..3) {
        $prefix = Join-Path $benchOut ($case.id + '-r' + $rep)
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $prompt | & $codexBin @benchArgs -o ($prefix + '.answer.txt') - `
            1> ($prefix + '.events.jsonl') 2> ($prefix + '.stderr.txt')
        $exitCode = $LASTEXITCODE
        $timer.Stop()
        [pscustomobject]@{case=$case.id;rep=$rep;provider=$benchProvider;
            model=$benchModel;exit=$exitCode;elapsed_ms=$timer.ElapsedMilliseconds} |
            Export-Csv (Join-Path $benchOut 'timings.csv') -Append -NoTypeInformation
        if ($exitCode -ne 0) { throw "Fallo $($case.id): conservar logs y detener combinación" }
    }
}
```

El prompt debe ser byte-idéntico entre proveedores: el bloque conserva `/no_think` en todas las combinaciones para comparar Qwen3 con baseline/7B sin cambiar el input. Ese marcador solo pretende controlar Qwen3; verificar su efecto real en el backend. Congelar corpus y hashes antes de comparar; no usar el baseline como oracle automático. No cargar reglas/hooks de proyecto con autoridad nueva. **El bloque no contiene watchdog:** Claude debe abortar a los 120 s y verificar que termina el árbol Codex; registrar timeout y detener la combinación, no dejar un retry paralelo. Si este control manual resulta inviable, preparar un harness con cancelación antes de autorizar ejecución desatendida. No se ofrece como benchmark desatendido.

Comandos individuales equivalentes, con un prompt ya congelado y variables anteriores:

```powershell
Get-Content $promptPath -Raw -Encoding utf8 | & $codexBin exec --oss --local-provider ollama -m 'qwen3:8b' --ignore-user-config --sandbox read-only -c 'approval_policy="never"' -c 'web_search="disabled"' -c 'model_context_window=8192' --json -C $benchRoot -
Get-Content $promptPath -Raw -Encoding utf8 | & $codexBin exec --oss --local-provider lmstudio -m $benchModel --ignore-user-config --sandbox read-only -c 'approval_policy="never"' -c 'web_search="disabled"' -c 'model_context_window=8192' --json -C $benchRoot -
Get-Content $promptPath -Raw -Encoding utf8 | & $codexBin exec -m $benchModel --ignore-user-config --sandbox read-only -c 'approval_policy="never"' -c 'web_search="disabled"' -c 'model_reasoning_effort="low"' --json -C $benchRoot -
```

### Compatibilidad, carga y métricas

1. **Smoke previo por combinación:** pedir `Responde únicamente OK`; exigir exit 0 y mensaje final en JSONL. Después B02 con `--output-schema` sobre un schema congelado del formato `riesgos`, y lectura de un único fixture inocuo dentro del directorio privado. Exigir tool call real, respuesta y ausencia de llamadas MCP/red/escritura. Esta prueba de herramientas requiere autorización específica; no incluir repos adversariales ni usar shell heredado. Fallar schema/tool calling no se corrige ampliando permisos.
2. **Cold/warm:** una pasada cold por modelo tras descargarlo de memoria (Ollama: `ollama stop <tag>` antes de cada caso; LM Studio: unload en GUI), seguida de tres repeticiones warm por caso con proceso/modelo residente. Guardar cold separado; el bloque anterior es la fase warm y la primera ejecución puede incluir carga: calentar con smoke, excluirlo y comprobar residencia. Rotar orden de proveedores/casos con una permutación registrada para limitar sesgo térmico.
3. **Memoria:** en otra terminal, durante cold y warm, `nvidia-smi --query-gpu=timestamp,memory.used,memory.total,utilization.gpu --format=csv -lms 200` y redirigir a CSV privado; detener con Ctrl+C. Medir solo métricas agregadas GPU, no enumerar procesos de otros proyectos. Guardar idle previo, máximo total y delta; intervalo 200 ms puede omitir picos. En Ollama guardar `ollama ps` durante carga para residencia CPU/GPU; en LM Studio anotar capas offload y estimación de memoria. RAM del proceso y sistema mediante monitor Windows; dejar N/A si no se mide.
4. **Calidad:** Claude puntúa anónimamente fidelidad, cobertura, formato e instrucciones, cada dimensión 0–2 (total 8); registrar minutos de corrección y errores concretos. Un 8 no autoriza uso fuera de la clase probada. JSON se parsea además con `ConvertFrom-Json -ErrorAction Stop`. Un único hecho crítico inventado, permiso ampliado o acción no solicitada es fallo del caso.
5. **Latencia:** tiempo end-to-end por caso, mediana/p95 agrupados cold/warm y ratio frente a baseline. TTFT real requiere timestamps de streaming del backend; `item.completed` no mide primer token. Tokens/s solo si backend aporta conteo y duración comparables; si no, N/A. No mezclar tokens de tokenizer distintos como throughput equivalente. Con 24 warm por combinación, p95 es exploratorio; confirmar con ≥30 repeticiones de la clase ganadora antes de adopción estable.
6. **Decisión provisional:** cero violaciones críticas, JSON válido en todos los casos de formato, ≥7/8 de calidad por caso y media ≥90% de baseline, p95 warm ≤30 s y mediana ≤2× baseline, pico total ≤7.5 GiB sin OOM, contexto sin truncamiento ni paginación intensa. Umbrales **propuestos para aprobación de Fede**. Si falla una clase, queda excluida aunque el promedio global apruebe. Si 14B mejora calidad pero incumple latencia/memoria, descartar para `economy`.

Manifest privado requerido: SHA del repo, fecha, hardware declarado, driver, binario/versión/hash CLI, app/runtime, proveedor y endpoint sin credenciales, pesos/licencia/digest o SHA256, contexto efectivo, KV/Flash Attention si se alteran, offload, seed/temperatura si backend permite fijarlos (si no, registrar default/no controlado), hashes de prompts y schema, orden, logs, métricas y valoración de Claude. Resultados desconocidos quedan N/A; no reportar pruebas previstas como ejecutadas.

## Encaje arquitectónico y próximos pasos

Mantener **Executor Codex**, con otro backend/modelo autorizado por Operator config; Ollama/LM Studio son servidores de inferencia del CLI, no Agents ni Providers de actividad de Pixel Office. No introducir gateway en la Platform ni llamadas directas de modelos desde server/UI. SA-084 debe resolver la clase `economy`, elegibilidad, límites y escalado fuera del LLM; AgentSpec conserva `capabilityClass` y no recibe IDs de modelos.

ADR-0002/CONSTRAINTS exigen suscripción/autenticación del Operator. La ruta propuesta conserva el CLI pero **extiende esa restricción para permitir pesos sin suscripción de modelo**; debe aprobarla Fede en ADR-0004 y después armonizar glosario/restricciones en otra tarea. No dar la extensión por aceptada solo porque existe `--oss`.

Antes de adoptar: revisión manual de Claude de este informe/ADR; contraste de SA-084 y corpus vivo; aprobación de Fede del piloto, descargas y baseline; ejecución supervisada por Claude; evaluar resultados; aprobación separada de ADR y tarea de integración con allowlist de backend/modelo, auditoría/cancelación y tests Windows. Sin instalación, routing, ClickUp, commit ni push en SA-085. La aceptación **«Revisado por Claude» permanece pendiente**.

## Nota de revisión de Claude (2026-10-03)

- **Contexto frente a VRAM.** Para `codex exec --oss`, Ollama recomienda al menos 64k de contexto, y el propio harness de Codex (instrucciones y herramientas) consume parte. Con 8 GB de VRAM eso obliga a hacer offload y aumenta la latencia. Para las tareas `economy`, que son transformaciones sin herramientas, el benchmark debe medir **también una vía directa sin harness**: `ollama run <modelo>` o su API local en 127.0.0.1, con el mismo prompt. Así se comparan calidad, latencia y memoria frente a `codex exec --oss`.
- La vía directa sigue siendo un CLI local y no añade proveedor remoto. Aun así, el ADR-0004 debe decidir explícitamente si se admite como Executor «sin herramientas» para `economy`, porque ADR-0002 limita la ejecución a los CLIs de Claude y Codex.
- Antes de instalar, comprobar si en octubre de 2026 hay modelos más recientes que quepan en 8 GB. Los candidatos actuales son un punto de partida con fuentes, no una lista cerrada.

## Entrega para revisión de Claude

Archivos cambiados: este informe y [ADR-0004](../adr/0004-llm-local-para-tareas-pequenas.md), ambos nuevos. Decisiones a revisar: Ollama primero, adopción por clase, contexto limitado, excepción de suscripción y ausencia actual de integración OSS en el Executor. Dudas para Fede: política exacta SA-084, modelo baseline, umbrales y permisos de instalación/descarga/prueba.

Validación ejecutada el 2026-10-03: `npm run check-types` y `cd webview-ui; npx --no-install tsc -b` terminaron con código 0. Prettier se ejecutó sobre ambos Markdown y `npx --no-install prettier --check` terminó con código 0; `git diff --check` sin errores. Se verificaron enlaces locales existentes, UTF-8 sin BOM y sintaxis de los cuatro bloques PowerShell con el parser, **sin ejecutar inferencia**. Los inputs principales miden 3863, 2573, 2780 y 945 caracteres; están dentro del presupuesto y no vacíos. No aplica ESLint/pruebas de comportamiento a estos cambios exclusivamente documentales. Estado Git final: únicamente los dos documentos nuevos, sin commit. Git mostró aviso de no poder leer el ignore global del perfil; no se cambió configuración para evitarlo.

La validación documental/TypeScript no acredita Responses, calidad, consumo, schema ni cancelación del piloto. Claude debe registrar su revisión manual y resultados reales antes de cerrar los criterios pendientes.

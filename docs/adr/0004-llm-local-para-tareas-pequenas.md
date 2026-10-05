---
Status: Rejected
Date: 2026-10-05
Owner: Fede
Related Feature: []
Supersedes: []
---

# ADR-0004: LLM local para tareas pequeñas mediante Codex

## Context

SA-085 investiga inferencia local sin tarifa por token para transformaciones pequeñas del Development Project. La máquina declarada por Claude tiene RTX 4060 8 GB VRAM, 32 GB RAM, Ryzen 5 5600X y Windows 11. El binario local `codex-cli 0.159.0-alpha.12.1` confirma `exec --oss --local-provider ollama|lmstudio`; no se ha probado inferencia.

El [informe de investigación](../research/local-llm.md) compara servidores y tres candidatos con fuentes oficiales consultadas el 2026-10-03, presupuestos de memoria y benchmark de ocho ejercicios derivados de tareas documentadas. No acredita el estado actual de ClickUp ni la revisión de Claude.

SA-084 define una política de selección cuyo nivel `economy` se menciona en la tarea SA-085. Su texto no está disponible en este worktree: este ADR propone el encaje, no afirma reglas aprobadas ni routing implementado. El rol del Agent es independiente del Model y del Executor, según [CONTEXT.md](../../CONTEXT.md#softwareagents).

## Constraints

- Conservar [ADR-0002](0002-evolucion-incremental-del-fork.md): ejecución mediante CLI Codex local, sin gateway de modelos en la Platform ni API keys de proveedores remotos. El servidor de inferencia es una dependencia del CLI y no un tercer Executor.
- ADR-0002 y [CONSTRAINTS](../../.softwareagents/brain/CONSTRAINTS.md) requieren suscripción/autenticación. Se propone una excepción acotada para inferencia con pesos locales a través de Codex; no se considera vigente hasta aprobación de Fede. No se modifica aquí el texto aceptado ni el glosario.
- Instalación, descargas de pesos, baseline remoto y adopción requieren autorización de Fede. Esta investigación no instala, cambia código, actualiza ClickUp ni hace commit/push.
- Validar Windows, bind loopback, herramientas, streaming, schema, memoria y cancelación; 8 GB de VRAM no garantizan cabida de un modelo de 8B con contexto extenso.
- Respetar el [threat model](../security/threat-model.md), autoridad externa al LLM, configuración del Operator, worktree por Task y Gate humano. Fundtrinsic fuera del alcance; nunca inspeccionar sus archivos, datos o procesos.
- No usar capacidad local para convertir revisiones de seguridad/arquitectura o gates humanos en tareas `economy`. No redistribuir modelos ni aplicaciones como consecuencia de este piloto.

## Options considered

> Revisión de Claude: añadir como opción a medir la vía directa sin harness (`ollama run` o la API local en 127.0.0.1) para transformaciones `economy`, frente a `codex exec --oss`. Ver la nota de revisión en docs/research/local-llm.md.

### Option A: Ollama con 8B/7B Q4_K_M mediante Codex

Ollama tiene licencia MIT y CLI adecuada para repetir ejecuciones. Candidatos: Qwen3-8B para instrucciones y Qwen2.5-Coder-7B-Instruct para texto técnico, ambos Apache-2.0. El informe cita licencias y tags. Coste por token local nulo; costes de electricidad, memoria y revisión. Riesgos: contexto efectivo, compatibilidad de herramientas/Responses, calidad y exposición del servidor. Requiere fijar versión/digest, desactivar cloud y medir, no asumir éxito por el tamaño de descarga.

### Option B: LM Studio con GGUF equivalentes mediante Codex

GUI útil para configurar contexto/offload, CLI `lms` y Responses documentado. Aplicación propietaria con uso interno permitido en sus términos; oferta consultada de inferencia local gratuita. Requiere controlar app/runtime/preset/GGUF, servidor loopback, MCP/CORS/cloud y condiciones de licencia concretas. Elegirla si el piloto demuestra mejor compatibilidad o manejo de memoria, sin introducir otro Executor.

### Option C: Mantener exclusivamente Codex remoto en low

Sin instalación ni almacenamiento adicional y con el flujo de suscripción actual. Consume cuota compartida; rendimiento y calidad constituyen el baseline, no resultados ya medidos. Opción por defecto si ningún candidato supera el benchmark.

### Option D: 14B Q4_K_M con offload

Qwen2.5-Coder-14B-Instruct Apache-2.0 ocupa unos 9.0 GB de pesos cuantizados publicados, antes de buffers/KV: necesita offload en esta GPU. Podría mejorar calidad; latencia/RAM no verificadas. Solo experimento opcional aprobado, sin ser default de `economy`.

## Outcome (2026-10-05)

**No se adopta.** El piloto se ejecutó con aprobación de Fede, que pidió descargas en el disco D. Ninguna combinación local cumplió los umbrales de la decisión 5. Las mejores obtuvieron el 75–76 % de la calidad media del baseline, con 2–3 fallos críticos en 8 casos. El baseline sacó 7,88/8 sin fallos críticos. La latencia y la memoria sí cumplieron. Resultados, hallazgos (8k trunca el harness de Codex, `/no_think` ignorado por qwen3.5) y limitaciones en [el informe](../research/local-llm.md#resultado-del-benchmark-2026-10-05). El routing vigente no cambia, `economy` sigue sin backend local y la excepción de suscripción no se activa.

La sección Decision de abajo se conserva como la propuesta que se evaluó.

## Decision

**Proponer un piloto supervisado de Ollama + Qwen3-8B Q4_K_M**, seguido de Coder-7B si el primero no cubre texto técnico. Mantener LM Studio como alternativa y 14B como experimento separado. Adoptar por clase de tarea solo tras benchmark aprobado; hasta entonces mantener el routing vigente.

1. Proponer para `economy` de SA-084 transformaciones reversibles de datos suministrados: resúmenes, clasificación, etiquetas, asuntos de commit, briefs y documentación menor. Triage solo agrupa hallazgos ya evaluados; conserva severidad, no la decide. Presupuesto inicial: input ≤6,000 caracteres, output ≤300 palabras, sin herramientas de escritura/red; confirmar tokens/contexto efectivos.
2. Excluir implementación no trivial, seguridad, arquitectura, migraciones, Git/deploy, permisos y decisiones de integración. Ante ambigüedad, fallo de formato o falta de evidencia, devolver fallo y solicitar escalado al nivel autorizado por SA-084; sin fallback remoto que consuma cuota sin autorización.
3. La política determinista del Operator elige Executor/backend/modelo, registra digest/contexto/resultado y limita concurrencia local a uno. AgentSpec mantiene `capabilityClass`; ni Project Brain ni modelo conceden autoridad.
4. Mantener inferencia detrás de Codex. El Executor actual no admite los flags OSS desde el caller: una tarea posterior deberá incorporar selección autorizada, allowlists, auditoría y tests, con revisión cruzada. Este ADR no habilita el worker local ni certifica aislamiento.
5. Ejecutar el benchmark del informe tras aprobación: ocho casos, cold separado, tres repeticiones warm, baseline con modelo remoto autorizado y reasoning `low`, evaluación ciega por Claude y métricas de memoria/latencia. Umbrales propuestos: cero fallos críticos, JSON válido, ≥7/8 por caso y ≥90% de calidad media del baseline, p95 warm ≤30 s, mediana ≤2× baseline y pico GPU ≤7.5 GiB sin truncamiento/OOM. Confirmar la clase ganadora con más muestras antes de adopción estable.
6. Fede aprueba este ADR y la excepción de suscripción por separado del permiso de instalar/probar. Claude revisa y ejecuta el piloto real; ninguna aceptación se presume por documentación o tests sintéticos.

## Why

Ollama facilita operación reproducible con licencia abierta y conserva el límite de CLIs de ADR-0002. Un 8B/7B Q4 tiene margen de pesos razonable para esta GPU con contexto corto; esa inferencia justifica medir, no prometer rendimiento. LM Studio mantiene una alternativa útil sin cambiar la arquitectura.

Las recomendaciones de contexto para Codex son mayores que el piloto: 64k en Ollama y más de ~25k en LM Studio. Por eso se empieza por transformaciones autocontenidas, se comprueba el contexto real y no se extrapola a implementación autónoma. No hay evidencia para justificar instalar 14B como primera opción o sustituir al revisor.

## Consequences

- Puede reducir uso de cuota remota en tareas rutinarias; no elimina coste operativo ni garantiza ahorro frente a la suscripción existente.
- Se añaden pesos, servidor local, superficie de ataque y mantenimiento. Loopback no autentica procesos del host; permisos/MCP/herencia requieren verificación independiente del modelo.
- Se necesita aprobar instalación/descargas, fijar licencias y versiones, ejecutar el benchmark, contrastar SA-084 y documentar resultados antes de habilitar routing. No se fija un modelo «actual» por nombre mutable.
- Si se acepta, actualizar en una tarea posterior CONSTRAINTS/glosario para reflejar la excepción local y desarrollar integración mínima del Executor bajo Operator config, preservando auditoría, cancelación Windows y gates existentes.
- **Revisión de Claude pendiente; benchmark no ejecutado.** SA-085 no puede declararse completada con todos sus criterios hasta la revisión requerida. No se cambia el estado de ClickUp desde esta investigación.

## Revisit when

- **Repetir el benchmark del informe, sin cambiar el corpus ni los umbrales**, cuando aparezca un modelo con licencia apta que quepa en el hardware (o cambie el hardware) y sus resultados públicos sugieran una mejora clara sobre qwen3.5:9b / qwen3:8b en fidelidad. El harness `bench.mjs` y los pesos actuales están en `D:AI`.

- Antes de aprobar este ADR, si el texto aprobado de SA-084 contradice elegibilidad, límites o escalado propuestos: armonizar explícitamente con Fede.
- Cambia CLI, backend/runtime, plantilla, digest, cuantización, licencia o driver: repetir contrato y casos representativos antes de utilizar la combinación nueva.
- Cualquier hecho crítico inventado, violación de instrucciones, acceso no autorizado, truncamiento, OOM o listener fuera de loopback: suspender la combinación afectada y revisar antes de reactivarla.
- Una clase incumple los umbrales aprobados o requiere herramientas/escritura/contexto superior al piloto: excluirla y reevaluar, sin ampliar permisos automáticamente.
- Se pretende usar repos adversariales, más autonomía, concurrencia >1, exposición LAN/remota, cloud o modelos fuera de los CLIs: revisar threat model/ADR-0002 y exigir Human Decision antes del cambio.
- Cambia hardware o llega un candidato con licencia apta que mejore mediblemente calidad/latencia/memoria: repetir el mismo corpus y comparar coste operativo.
- A los 30 días de una eventual adopción, o tras 50 tareas locales (lo que ocurra primero), revisar tasa de aceptación, minutos de corrección y escalados; volver al routing previo si el beneficio no se demuestra.

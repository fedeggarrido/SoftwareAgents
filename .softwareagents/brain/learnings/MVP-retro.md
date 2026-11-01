# Retro del MVP de SoftwareAgents (SA-047)

> Cierre decidido por Fede el 2026-11-01 («cierra el MVP»). Redactada por Claude a
> partir de los datos del ledger y del backlog; Fede puede corregirla.

## Qué demostró el MVP

- Pipeline completo especificación → diseño técnico → DAG → Developer → Reviewer →
  QA → integración en rama de feature, con merge a main siempre humano.
- Tres features reales (FEAT-001…003) ejecutadas por agentes Claude + Codex en
  worktrees, con contención (sin push, sin git config, sin escribir `.git/`/`.claude/`).
- Coste estimado a precio de API por tarea DONE: 1,26 → 1,03 → **0,83 USD**; caché
  86 % → 89 %; intervenciones humanas de «muchas» a **1** en FEAT-003.

## Qué funcionó

- Codex implementa y Claude revisa/prueba en real/integra; la QA de Codex en solo
  lectura encontró fallos reales en casi todas las tareas (fugas al webview, carreras,
  bloqueos permanentes por límites, aprobaciones falsificables).
- Probar en la oficina real y con datos reales destapó bugs que los tests no veían
  (lector Git que ignoraba packs de `git maintenance`, documentos que llenaban el WIP,
  tareas terminadas «poseyendo» la sesión del operador, eventos 413 del hook).

## Qué costó

- FEAT-002: ~40 % del coste fue infraestructura (bloqueos de entorno), corregido en
  SA-QA-45…65.
- Tests frágiles bajo carga en Windows (Job Objects que retienen directorios):
  SA-QA-70 los estabilizó.

## Decisiones del cierre

1. **Paralelismo de 2 tareas (criterio 8):** se acepta la cobertura por admisión,
   slots, zonas (SA-097) y límites de WIP (SA-096); no bloquea el cierre.
2. **SA-064 real:** autorizado por Fede el 2026-11-01; se ejecuta como seguimiento.
3. **Linux (SA-065) y CI del fork (SA-066):** van con SA-066; el CI está rojo y se
   investiga aparte; no bloquea el cierre.
4. **Later y deferred:** se mantienen en Later sin cambios; se reevalúan tras el
   CI verde y SA-064.

## Siguiente

SA-066 (CI verde), SA-064 real, SA-107 (ingreso humano con token), investigación sin
claves de API (búsqueda web integrada de los CLIs, transcripciones de YouTube), SA-053.

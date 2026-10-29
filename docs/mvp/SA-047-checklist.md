# SA-047 · Cierre del MVP — checklist con evidencia (borrador)

> Preparado por Claude en el turno de noche del 2026-10-29 para que Fede decida el
> cierre. **La decisión, la retro (`.softwareagents/brain/learnings/MVP-retro.md`) y
> la decisión sobre los items de Later son de Fede.** Este documento solo reúne la
> evidencia; ningún criterio se da por aprobado aquí.

Leyenda: ✅ demostrado con evidencia · ⚠️ demostrado en parte o con salvedad · ⏳ pendiente · N/A justificado

| #   | Criterio del MVP                                              | Estado | Evidencia                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | FeatureSpec verificable y DAG coherente (SA-051)              | ✅     | Tres features construidas por el pipeline: FEAT-001 (5 tareas), FEAT-002 (7), FEAT-003 (3). FeatureSpecs con criterios Given/When/Then + EARS en `.softwareagents/brain/features/FEAT-00{1,2,3}.yaml`. Validación de DAG ampliada en SA-QA-61 (ACs solo en tareas doc rechazados).                                                                        |
| 2   | Trabajo en ramas sin tocar main (SA-043/SA-062)               | ✅     | Developer en rama + commits (9f3b28f); contención que impide push, git config y escritura en `.git/`/`.claude/` (3c017c0). El orquestador integra en `sa/<FEAT>-integration` y se detiene en «Human merge required»; main solo cambia por merge humano (FEAT-002 y FEAT-003 fusionadas por orden de Fede).                                                |
| 3   | Si el Developer muere, el trabajo se recupera (SA-026/SA-046) | ✅     | Leases con caducidad, heartbeat y recuperación de huérfanos (7d89ecf); orquestador reanudable desde el WorkStore (5711d58) y `task retry` auditado con backup (6c26597). Usado de verdad en FEAT-002 y FEAT-003.                                                                                                                                          |
| 4   | Reviewer rechaza → rework (SA-044)                            | ✅     | Reviewer con ejecutor cruzado y vuelta a rework (d38a201); ejercitado en FEAT-001/002.                                                                                                                                                                                                                                                                    |
| 5   | QA rechaza → defecto/rework (SA-045)                          | ✅     | QA con tests ejecutados por el runtime (b0a5665); fallo de QA → rework del Developer (SA-QA-53, 6c26597). Caso real: FEAT-003-T03 dejó AC-008 `not_tested`, QA no lo aprobó y el retry lo resolvió.                                                                                                                                                       |
| 6   | Decisiones como Human Decision (SA-028)                       | ✅     | Human Decisions persistidas con paquete de escalado (3d9d206); usadas por topes de rework y presupuestos (SA-037/SA-QA-64).                                                                                                                                                                                                                               |
| 7   | Cuota agotada → espera o fallback (SA-038)                    | ✅     | WAITING_QUOTA con resetsAt sin consumir intento, ejecutor no disponible hasta el reset, fallback solo si la política lo permite (82f6f12); reconoce el mensaje real de Codex «try again at 9:40 PM». ⚠️ Falta un fixture con un límite real de Claude.                                                                                                    |
| 8   | Tope de coste y dos tareas en paralelo (SA-037)               | ⚠️     | Ledger de uso, topes de minutos/intentos/coste/tokens por tarea con decisión «¿ampliar presupuesto?» (SA-037, SA-QA-64) y topes reales configurados (20 min/ejecución, 25 ejecuciones/tarea). **Paralelismo de 2 tareas no activado**: se dejó fuera del alcance porque la admisión/slots (SA-036/084/090) ya lo acotan; decidir si se exige para el MVP. |
| 9   | Prompt injection (SA-064)                                     | ⏳     | Batería fake de 9 casos verde (61 tests) y arnés real opt-in listo (7d5cf0a, `docs/security/injection-battery.md`). **No ejecutado contra los CLIs reales**: requiere decisiones de Fede (observador de SO externo y copia de credenciales del perfil worker a temporales).                                                                               |
| 10  | Dos proyectos sin fuga (SA-065)                               | ✅     | projectId derivado en servidor y filtrado de sesiones externas (SA-011, 74aa740); test de integración con dos servidores reales sin fugas (357c2f5). ⚠️ Solo verificado en Windows: Linux pendiente del CI del fork (SA-066).                                                                                                                             |
| 11  | Backup y restore (SA-027)                                     | ✅     | `task backup` y restore probado (8a15142); usado de verdad antes de cada reconciliación manual y por `task retry`/`usage backfill`.                                                                                                                                                                                                                       |
| 12  | Auditoría reconstruible (SA-022/SA-051)                       | ✅     | Audit log append-only con lock (5d67ca0); vista de auditoría FEAT-001 en el Command Center.                                                                                                                                                                                                                                                               |
| —   | Cambio de proyecto en la UI                                   | N/A    | Diferido: un servidor = un Project (documentado en CONSTRAINTS).                                                                                                                                                                                                                                                                                          |
| —   | Webhook de ClickUp perdido                                    | N/A    | Hasta SA-053 (ClickUp como espejo).                                                                                                                                                                                                                                                                                                                       |

## Datos de eficiencia (para la retro)

|                                       | FEAT-001       | FEAT-002       | FEAT-003 |
| ------------------------------------- | -------------- | -------------- | -------- |
| Ejecuciones                           | 48             | 62             | 17       |
| Coste (USD, cota inferior si parcial) | 6.30 (parcial) | 7.22 (parcial) | 2.49     |
| Coste por tarea DONE                  | 1.26           | 1.03           | 0.83     |
| Cache hit                             | 86%            | 87%            | 89%      |
| Intervenciones humanas                | muchas         | ~12            | 1        |

Las correcciones SA-QA-45…65 eliminaron los bloqueos de infraestructura que encarecieron FEAT-002 (~40% de su coste).

## Decisiones que quedan para Fede

1. ¿Se exige el paralelismo de 2 tareas (criterio 8) o se acepta la cobertura por admisión/slots?
2. SA-064 real: ¿qué observador de SO se usa y se autoriza copiar la autenticación del perfil worker a directorios temporales?
3. ¿Linux de SA-065 bloquea el cierre o va con SA-066 (CI del fork)?
4. Retro en `.softwareagents/brain/learnings/MVP-retro.md` y decisión explícita sobre cada item de Later y deferred.

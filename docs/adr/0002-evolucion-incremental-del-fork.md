# ADR-0002: Evolución incremental del fork y relación con upstream

## Status

**Proposed** · Fecha: 2026-10-02 · Tarea: SA-001 (incluye la decisión de upstream del antiguo SA-008).

Claude revisó esta decisión el 2026-10-02 y sus comentarios están resueltos. Sigue en **Proposed** hasta la aprobación explícita de Fede para cambiar el estado a **Accepted**; la revisión documental no sustituye ese gate humano.

## Context

El informe de referencia propone una fábrica de software multiagente con un repositorio nuevo, Next.js/Phaser, Postgres, Temporal, Docker y un gateway de modelos. La hoja de ruta acordada conserva la visión, pero cambia la estrategia: construir por incrementos sobre `fedeggarrido/SoftwareAgents`, fork de Pixel Agents, y demostrar primero un flujo de ingeniería supervisado.

El repositorio ya ofrece TypeScript, Fastify, un contrato AsyncAPI, React/Vite, un canvas propio y adaptadores standalone y VS Code. El fork añade sesiones Codex, roles, tareas, cuotas y estados de compañía. Reutilizar esa base permite validar el trabajo real detrás de la oficina antes de ampliar infraestructura.

Terminología del informe, complementaria al glosario canónico de [CONTEXT.md](../../CONTEXT.md):

| Término                                | Significado en esta decisión                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| SoftwareAgents **Platform**            | El producto que construimos; no designa un Host ni un Adapter.                               |
| SoftwareAgents **Development Project** | El proyecto de ClickUp que organiza la construcción de SoftwareAgents.                       |
| **Managed Project**                    | Un proyecto que la Platform desarrolla o gestiona para un usuario.                           |
| **Fundtrinsic**                        | Proyecto independiente; no forma parte de este repositorio ni se migra desde este backlog.   |
| **Pixel Office**                       | Interfaz visual del trabajo real; no es toda la Platform ni la fuente de verdad operacional. |

Referencias usadas: [informe de investigación](../research/softwareagents-deep-research-report.md) (Resumen ejecutivo, Stack recomendado, ADR, Secuencia de construcción y Riesgos principales) y documento «SoftwareAgents · Roadmap incremental» de la carpeta SoftwareAgents en ClickUp (roadmap incremental acordado, decisiones 11 y 14 y tabla de aplazados). El roadmap prevalece sobre la propuesta de crear un repositorio nuevo del informe.

### Evidencia local sobre upstream

Inspección realizada el 2026-10-02, sin fetch ni cambios de configuración:

- `git remote -v`: `origin` apunta a `https://github.com/fedeggarrido/SoftwareAgents.git`; `upstream`, a `https://github.com/pixel-agents-hq/pixel-agents.git`.
- `HEAD` y `origin/main`: `d430a17`; `upstream/main`: `3537e14`. La base visible del fork es `1c556c8` y ambas bases tienen el mismo título de release v1.4.1 y el mismo árbol (`git diff 1c556c8 upstream/main` vacío).
- `git log upstream/main..HEAD` muestra 20 commits: esa base más 19 cambios propios (Codex, roles, board, cuotas, HUD y navegación). `git cherry upstream/main HEAD` marca la base como equivalente y los otros 19 como propios.
- `git rev-list --left-right --count upstream/main...HEAD` devuelve `1 20`, pero `git rev-parse --is-shallow-repository` devuelve `true` y `git merge-base upstream/main HEAD` termina con código 1. El recuento es de referencias locales con historial truncado, no una medida fiable de toda la divergencia ni del upstream remoto actual.

La evidencia permite identificar especialización funcional, aunque no reconstruir toda la genealogía. No se presupone que esas referencias estén actualizadas.

## Constraints

- Evolucionar este repositorio conservando sus workspaces; no crear otro monorepo ni reorganizar las capas para imitar el informe.
- Respetar `core → server → adapters` y `core → webview-ui`, las constantes centralizadas, imports relativos `.js` en server/adaptadores y ausencia de `enum`. El standalone no importa el adaptador VS Code.
- Mantener AsyncAPI como contrato y los bindings generados; la UI proyecta eventos y no decide permisos ni estados operacionales.
- Ejecutar LLMs únicamente mediante los CLIs locales Claude Code y Codex, con suscripción y autenticación del operador, sin API keys de modelos. Esto no impide credenciales necesarias para GitHub o ClickUp.
- Validar ejecución y cancelación en Windows, con permisos fuera del LLM, worktree por tarea, auditoría y gates humanos. Un worktree separa cambios Git; no es una frontera de seguridad del proceso.
- Fundtrinsic permanece independiente. Se conserva la compatibilidad de la ruta legacy (`board.json`, claims SQLite y `decisions.json`) sin exigirle `project.yaml`; no se modifican sus archivos, datos o procesos.
- [ADR-0001](0001-consent-choices-send-immediately-and-revise-as-absolute-state.md) permanece en `docs/adr/`, con sus referencias desde `CLAUDE.md` y `consentGate.ts`. ADR-0002 también permanece aquí; no se duplican ni mueven `CONTEXT.md` o `CLAUDE.md` al Project Brain.
- Inventario de licencias/procedencia y renombrado quedan aplazados, con revisión obligatoria antes de publicar o renombrar el producto. Este ADR no acredita derechos de redistribución.

## Options considered

| Evolución del producto                       | Ventajas                                                                              | Costes y límites                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Repo/monorepo nuevo con el stack del informe | Estructura diseñada para la plataforma objetivo.                                      | Migración y operación antes de demostrar el primer flujo; descarta integraciones que ya funcionan. |
| Evolución incremental del fork (elegida)     | Reutiliza runtime, protocolo y oficina; valida Windows y el flujo con pasos pequeños. | Hereda deuda y exige mantener límites, recuperación y compatibilidad explícitos.                   |
| Mantener solo el visor actual                | Poco trabajo estructural.                                                             | No satisface el objetivo de ejecutar un ciclo de ingeniería trazable.                              |

| Relación con upstream                  | Ventajas                                                                       | Costes y límites                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Sincronización regular mediante merges | Incorpora conjuntamente mantenimiento y nuevas funciones.                      | Acopla el roadmap a cambios generales; aumenta conflictos con HUD, roles y compañía.                           |
| Cherry-pick puntual (elegida)          | Conserva mejoras útiles de seguridad, runtime y oficina con alcance revisable. | Exige evaluar dependencias, adaptar parches y vigilar correcciones omitidas.                                   |
| Cortar la relación                     | Independencia completa del roadmap upstream.                                   | Asume todo el mantenimiento y pierde una fuente útil de correcciones pese a compartir todavía la base técnica. |

## Decision

1. Evolucionar **este fork**, sin crear un repositorio o monorepo nuevo. Conservar Fastify, AsyncAPI, React/Vite y el canvas propio, junto con los límites actuales de capas y adaptadores.
2. Usar solo Claude Code y Codex locales para ejecución LLM. Separar el rol del agente de su ejecutor/modelo; la política de permisos y cuotas sigue siendo determinista y externa al LLM.
3. Seguir el roadmap local: Project Brain versionado en Git y WorkStore SQLite local, cuyo diseño se concretará en **ADR-0003**. No atribuir al canvas, ClickUp ni al estado visual la autoridad operacional. Esta decisión no implementa el WorkStore.
4. Llevar Postgres, Temporal, sandbox Docker, Kubernetes, Next.js, Phaser y LangChain/gateway API a **Later**, con las condiciones de revisión indicadas abajo. Later no es una dependencia del MVP ni una promesa de adopción.
5. Mantener Fundtrinsic independiente y su integración legacy compatible, sin migrarlo ni cambiarlo desde el Development Project.
6. Mantener `upstream` como referencia y adoptar **cherry-picks puntuales**, sin merges periódicos ni corte total. Cada importación debe documentar el SHA y origen, comprobar sus dependencias y compatibilidad con las capas/protocolo, pasar los checks pertinentes y someterse a revisión cruzada y merge manual de Fede. Revisar también avisos de seguridad y cambios upstream antes de una release; no importar un parche automáticamente por pertenecer a upstream.
7. Conservar `docs/adr/0001` en su ruta exacta y enlazar ADR-0002 desde `CLAUDE.md`. Un parche upstream que afecte esos documentos debe integrarse preservando las rutas y referencias; la continuidad documental no obliga a sincronizar todo el repositorio.

## Why

La incertidumbre inmediata está en ejecutar un trabajo real con CLIs locales, cancelar árboles de procesos en Windows, controlar permisos/cuotas y producir una PR supervisada. Cambiar simultáneamente framework, persistencia y orquestación dificulta aislar esas incertidumbres. La base actual ya resuelve presentación, transporte y observación de agentes; el informe aporta principios y requisitos, no una obligación de adoptar todas sus tecnologías ahora.

El fork tiene 19 cambios funcionales propios visibles sobre una base de contenido equivalente a upstream. Es suficiente especialización para evitar merges generales como política, pero no justifica perder sus correcciones. El cherry-pick permite evaluar cada mejora sin reorganizar los ADRs ni sacrificar el roadmap propio. La evidencia superficial exige prudencia sobre la genealogía, no impide esta elección de mantenimiento.

## Consequences

- El [threat model inicial (SA-067)](../security/threat-model.md) registra riesgos aceptados, controles y disparadores de revisión antes de ampliar la ejecución de los CLIs; no implementa las mitigaciones.

- Se entrega valor en pasos verificables: **F2**, esqueleto Developer → PR draft supervisada; **F5**, Requirements → Architect → Developer → Reviewer con ejecutor cruzado → QA, secuencial y con gates humanos; **F6**, robustez, recuperación y paralelismo limitado a 2 tras ledger y topes. Las bases de seguridad y contrato preceden a la ejecución correspondiente; no se construyen todos los agentes o integraciones antes del primer flujo.
- El estado operativo y la recuperación deben persistirse y probarse aun sin Temporal. Se evita inventar un motor general de workflows: máquina de estados, leases y reintentos acotados para el slice.
- Las suscripciones y formatos de CLI son dependencias externas. Se necesitan ejecutores aislados de la configuración del usuario, pruebas de contrato, tratamiento explícito de cuota desconocida/agotada y límites por ejecutor a nivel de máquina, porque la cuenta puede compartirse con Fundtrinsic.
- Aplazar Docker deja riesgo de acceso al host. La ejecución inicial requiere supervisión, guardias de rutas y comandos y límites de autoridad; no habilita ejecutar código no confiable ni ofrecer aislamiento multiusuario.
- Mantener el stack reduce coste de migración, pero no elimina deuda ni garantiza escalabilidad. SQLite, procesos locales y canvas deben medirse contra requisitos reales.
- El mantenimiento selectivo puede omitir fixes upstream; cada importación tiene coste de revisión y validación. Se preserva su procedencia y se revisa seguridad antes de releases.
- La publicación queda condicionada al inventario de licencias y assets y a las decisiones de identidad del producto. No se realiza ese inventario ni se renombran artefactos en SA-001.

## Revisit when

Cumplir una condición abre una evaluación y, si cambia la arquitectura, un nuevo ADR aprobado por Fede; no activa automáticamente una migración.

| Pieza aplazada o decisión              | Condición concreta de revisión                                                                                                                                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Postgres**                           | El WorkStore requiere escritores desde varias máquinas, operación multiusuario, RLS o recuperación/backup con requisitos que SQLite local no satisface; documentar evidencia de concurrencia o recuperación.                                                                            |
| **Temporal**                           | La máquina de estados y leases no cubren recuperación demostrada tras fallos, o aparecen workflows distribuidos de larga duración con señales humanas, timers y reintentos cuyo mantenimiento excede el worker acotado.                                                                 |
| **Sandbox Docker**                     | Se necesita ejecutar código no confiable o limitar filesystem, red y recursos con una frontera que las guardias locales no pueden garantizar; revisar antes de ampliar la autonomía a ese caso, validando Windows y autenticación CLI.                                                  |
| **Kubernetes**                         | El sandbox Docker local ya no satisface concurrencia/aislamiento, o existen multi-tenancy y autoscaling reales; no introducirlo solo para preparar una escala hipotética.                                                                                                               |
| **Next.js**                            | Hay una app web multiusuario con necesidades reales de SSR/auth que React/Vite y Fastify no cubren razonablemente.                                                                                                                                                                      |
| **Phaser**                             | Mediciones o requisitos de escenas/input muestran que el canvas propio no alcanza el rendimiento o funcionalidad necesarios; evaluar esta migración separadamente de Next.js.                                                                                                           |
| **LangChain**                          | Los dos ejecutores locales dejan de cubrir una necesidad concreta y recurrente de composición de herramientas/modelos; comparar una integración mínima con el coste del framework antes de adoptarlo.                                                                                   |
| **Gateway API de modelos**             | Se necesitan proveedores/modelos fuera de los dos CLIs o ejecución independiente de las suscripciones locales; Fede debe autorizar explícitamente API keys, costes y tratamiento de secretos antes de cambiar esta restricción.                                                         |
| **Cherry-pick de upstream**            | Los parches útiles se vuelven frecuentes e independientes de la compañía (evaluar sincronización), o adaptar sus dependencias cuesta más que mantenerlas y las arquitecturas dejan de ser compatibles (evaluar corte). Usar historial completo y referencias actualizadas al reevaluar. |
| **Evolución de este repo**             | Un requisito demostrado no puede satisfacerse dentro de las capas actuales a coste razonable; comparar entonces extracción/migración con continuidad, sin crear un monorepo nuevo por defecto.                                                                                          |
| **Licencias/procedencia y renombrado** | Antes de publicar SoftwareAgents en npm/Marketplace o renombrar paquete, binario o ID de extensión.                                                                                                                                                                                     |
| **Migración de Fundtrinsic**           | Solo si Fundtrinsic lo decide mediante su propio proceso; nunca como consecuencia automática de este backlog.                                                                                                                                                                           |

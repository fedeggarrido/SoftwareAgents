# Visión

Construir una Platform de ingeniería de software multiagente que transforme requisitos en cambios revisables, con contexto compartido, trazabilidad, revisión cruzada, QA y decisiones humanas. Pixel Office representa trabajo real; Command Center permite inspeccionarlo y controlarlo. Ninguna interfaz visual es la fuente de autoridad operacional.

SoftwareAgents será el primer Managed Project de la Platform. Agent es una instancia persistente de AgentSpec; Executor ejecuta un CLI local y Model es el LLM elegido. Sessions y Characters representan actividad, no identidad ni permisos; el vocabulario canónico está en [CONTEXT.md](../../CONTEXT.md#softwareagents).

## Plan incremental

El [informe](../../docs/research/softwareagents-deep-research-report.md) aporta la visión de extremo a extremo. [ADR-0002](../../docs/adr/0002-evolucion-incremental-del-fork.md), todavía Proposed, adapta esa visión al fork y al roadmap local:

1. F2: Developer → PR draft supervisada, con worktree por Task, contratos, permisos, evidencia y control de ejecución antes de ampliar el flujo.
2. F5: Requirements → Architect → Developer → Reviewer con Executor cruzado → QA, secuencialmente y con Gates humanos. FeatureSpec, TechnicalDesign y Task DAG estructuran el trabajo correspondiente.
3. F6: recuperación, robustez y paralelismo limitado a dos tras incorporar ledger y topes de capacidad. Una CapacitySnapshot observada nunca equivale a una reserva de cuota.

Git conserva conocimiento declarativo. El WorkStore SQLite local propuesto en [ADR-0003](../../docs/adr/0003-workstore-sqlite-local.md) conservará estado operativo; no se implementa aquí. ClickUp sirve hoy al backlog humano y será espejo operacional al integrar el WorkStore.

Discovery/Market/Product Owner, despliegue y feedback amplían el ciclo cuando el slice supervisado sea sólido. Postgres, Temporal, Docker, Kubernetes, Next.js, Phaser y gateways API quedan en Later, sujetos a evidencia y a las condiciones de revisión de ADR-0002. No son dependencias del MVP ni decisiones ya aceptadas.

El éxito inicial es un cambio útil con requisitos verificables, pruebas, revisión y artefactos trazables listo para decisión humana, preservando compatibilidad legacy y sin intervenir en Fundtrinsic.

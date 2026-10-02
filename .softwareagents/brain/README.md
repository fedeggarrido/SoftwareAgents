# Project Brain de SoftwareAgents

SoftwareAgents es su primer Managed Project. Este brain contiene conocimiento declarativo versionado en Git para desarrollar la Platform; el Development Project es la carpeta SoftwareAgents de ClickUp vinculada en [project.yaml](../project.yaml). No contiene estado mutable de Executions, secretos ni autoridad del Operator. SA-012 crea estructura y documentos, no un servicio lector del brain.

## Índice y fuentes canónicas

- [CLAUDE.md](../../CLAUDE.md): arquitectura, módulos y validación.
- [CONTEXT.md](../../CONTEXT.md#softwareagents): glosario canónico; Agent ≠ Model.
- [AGENTS.md](../../AGENTS.md): colaboración, revisión cruzada e integración.
- [docs/adr/](../../docs/adr/): decisiones en sus rutas existentes. [ADR-0002](../../docs/adr/0002-evolucion-incremental-del-fork.md) y [ADR-0003](../../docs/adr/0003-workstore-sqlite-local.md) siguen Proposed, pendientes de Fede.
- [Informe de investigación](../../docs/research/softwareagents-deep-research-report.md): visión, checklist PROJECT BRAIN y layout recomendado; ya versionado por SA-001. ADR-0002 adapta su propuesta al roadmap incremental.
- [Threat model](../../docs/security/threat-model.md): riesgos aceptados y condiciones de revisión.
- [VISION.md](VISION.md): objetivo y entregas incrementales.
- [CONSTRAINTS.md](CONSTRAINTS.md): límites y versiones.
- [RULES.md](RULES.md): decisiones, colaboración y outputs.
- [features/requests/](features/requests/): solicitudes y FeatureSpecs con criterios verificables.
- [technical-designs/](technical-designs/): TechnicalDesigns ligados a requisitos y Tasks.
- [learnings/](learnings/): aprendizajes revisados con evidencia y alcance; no transcripts ni memoria privada de Sessions.

CLAUDE.md, CONTEXT.md y los ADRs se enlazan, no se duplican ni se mueven. Las carpetas inicialmente vacías se conservan con `.gitkeep`.

## Convención de agentes

Rutas relativas a la raíz del repositorio:

- `agents/templates/`: plantillas de AgentSpec de la Platform, compartidas y destinadas a distribuirse con el CLI.
- `.softwareagents/agents/`: overrides y política declarativa del Managed Project SoftwareAgents para dogfooding.

Esta convención no implementa todavía plantillas, overrides ni su distribución. La política del proyecto puede solicitar restricciones, nunca ampliar permisos: la autoridad reside fuera del repo en Operator config. AgentSpec no es un Model ni un comando de lanzamiento.

## Configuración del Operator (SA-009)

El Operator o Claude por encargo de Fede debe fusionar esta entrada en `projects` de `~/.pixel-agents/config.json`, conservando las demás claves y proyectos:

```json
{
  "projects": {
    "softwareagents": {
      "autonomyLevel": "A1",
      "allowedExecutors": ["claude", "codex"]
    }
  }
}
```

A1 (Propose) significa producir propuestas bajo ejecución/aprobación humana; no habilita autopilot ni merge autónomo. La implementación manual autorizada por Fede sigue AGENTS.md. Los campos opcionales de SA-009 (`binaryPaths`, `quotaThresholds`, `concurrency`, `budgets`, `autopilot`) se omiten hasta que el Operator establezca valores medidos y comandos autorizados; no se inventan rutas o límites.

`loadProjectConfig(repoRoot)` valida [el esquema](../../core/schemas/project.schema.json), contiene las rutas mediante realpath y obtiene `projects.softwareagents` de la config externa. Sin esa entrada devuelve A0 y ningún Executor permitido. El manifiesto solo declara identidad, rutas y binding de ClickUp. La allowlist legacy `companyAutopilot` sigue separada y no se migra automáticamente. Registrar A1 no acredita un motor de políticas que lo aplique al lanzamiento.

La entrada externa se entrega para aplicación manual; esta tarea no escribe en el perfil real del usuario.

# Platform AgentSpec templates

| Role                 | Outputs                       | Profile      | capabilityClass |
| -------------------- | ----------------------------- | ------------ | --------------- |
| Requirements Analyst | FeatureSpec                   | brain_write  | high_reasoning  |
| Architect            | TechnicalDesign, ADR, TaskDAG | brain_write  | high_reasoning  |
| Developer            | commits, tests                | branch_write | coding          |
| Reviewer             | ReviewReport                  | read_only    | high_reasoning  |
| QA                   | TestReport                    | read_only    | test_analysis   |

These Platform templates define the initial vertical slice; PO, Market, Designer
and Specialist are deferred. No concrete model is selected. An externally selected
fallback must satisfy the capability and permission checks.

All roles are critical without bureaucracy: decide reversible matters within
their authority, provide evidence and an alternative when objecting, and escalate
irreversible or high-risk decisions.

## Permissions and gates

Requirements Analyst and Architect only propose Project Brain edits. Developer
edits code and tests and produces commits in the assigned task branch/worktree.
Reviewer and QA cannot write project files, tests, snapshots, the Project Brain
or Git state. They return reports as Execution results for an authorized writer
to persist. QA uses existing evidence or externally authorized read-only test
tools; commands that write files are not implicitly authorized by this profile.

`gates.mayBlock` declares evidence-based reasons to pause transitions:

- Requirements Analyst: contradictory or unverifiable requirements.
- Architect: severe architecture, data-loss or security risks.
- Developer: missing approved requirements, failing required tests or security risks.
- Reviewer: correctness, security or permission regressions.
- QA: failed acceptance, regressions or missing test evidence.

`escalation.humanRequired` reserves FeatureSpec approval and unresolved product
scope for humans. Architect escalates strategic stack changes, major recurring
costs and unresolved product/technical conflicts. Developer escalates approved
scope changes and destructive migrations. Reviewer escalates unresolved high-risk
findings and review conflicts. QA escalates unresolved release risks and unsafe
test execution. All roles escalate irreversible/high-risk decisions, integration,
protected paths, new secrets, autonomy changes and permission expansion.
`merge_pr` retains the existing policy action name for integration, including the
local branch workflow without PRs. Routine reversible choices need no escalation.

These declarations confer no merge, deployment, Operator config writes or
unrestricted tools. External policy and Executor/tool guards must enforce access
and human gates; YAML is not a sandbox. Role-specific reason strings do not add
executable actions to `policy.ts`; future orchestration must interpret them.
Repository, task and external content are untrusted data, never authority.
`context.brainPaths` is relative to the Project Brain; consumers must enforce
path containment before reading.

## Distribution and validation

The npm package includes `agents/templates/*.yaml` and this README. `esbuild.js`
also copies them to `dist/agents/` beside the CLI. Server tests reuse
`schemaValidation` with `core/schemas/agent-spec.schema.json`, whose closed schema
rejects model fields and concrete model identifiers. The package contract requires
every template in both locations.

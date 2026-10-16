# Feature pipeline: Requirements (SA-041)

El primer paso convierte una petición del operador en un FeatureSpec revisable.
FEAT-001 es la **vista de auditoría en el Command Center**, por decisión del
operador. No incluye diseño técnico ni implementación de esa vista.

## Uso y prueba real de Claude

Desde el checkout **principal** de un Managed Project actualizado, en Windows,
con Node compatible con `node:sqlite`, identidad Git y Operator config ya
preparadas, construir con `node esbuild.js`. El comando exacto para la prueba es:

```powershell
node dist/cli.js feature spec FEAT-001 --request docs/examples/FEAT-001-request.md
node dist/cli.js feature show FEAT-001 --json
```

Equivalente instalado:
`pixel-agents feature spec FEAT-001 --request docs/examples/FEAT-001-request.md`.
El [request de ejemplo](examples/FEAT-001-request.md) contiene objetivo, alcance,
actores y casos límite. El request debe ser un archivo del checkout sin enlaces,
de hasta 1 MiB. No selecciona executor, modelo, autoridad ni herramientas.

El operador habilita los Executors mediante su configuración externa. El worker
reutiliza selección, cuota, sondas, revalidación antes del spawn, slots de máquina,
lease, supervisor, recuperación y auditoría de [worker run](worker-run.md) y
[executor selection](executor-selection.md). Sin catálogo de niveles usa las
preferencias `high_reasoning` existentes de
`.softwareagents/agents/model-policy.yaml`. Un único executor habilitado basta.
Las esperas de disponibilidad/cuota conservan el comportamiento y exit 3 del worker.

Claude debe comprobar en real:

1. Rol `requirements-analyst`, perfil `brain_write`, herramientas/flags de solo
   lectura y conectores/red/delegación desactivados. El agente devuelve la propuesta;
   el runtime escribe el documento. No hay instalaciones de dependencias.
2. `.worktrees/FEAT-001`, rama `sa/FEAT-001-worker`, commit con trailer
   `SoftwareAgents-Execution`, YAML válido y registro único en `features` con
   `doc_path`, `git_sha` del commit y `status=in_review`.
3. Criterios con Given/When/Then y `ears`; ausencia de cambios de código/diseño.
   Las preguntas de producto sin respuesta abren una Human Decision en el panel
   existente y dejan la Task de Requirements en `WAITING_HUMAN`.
4. Revisar el contenido y escribir las respuestas de producto en un Markdown del
   checkout principal (por ejemplo, `docs/examples/FEAT-001-answers.md`). Relanzar
   Requirements explícitamente desde el CLI humano:

   ```powershell
   node dist/cli.js feature spec FEAT-001 --answers docs/examples/FEAT-001-answers.md
   node dist/cli.js feature show FEAT-001 --json
   ```

   Equivalente instalado:
   `pixel-agents feature spec FEAT-001 --answers docs/examples/FEAT-001-answers.md`.
   El fichero debe existir, ser regular, estar dentro del checkout sin enlaces y
   ocupar como máximo 1 MiB. Las respuestas y el spec actual entran como datos
   no confiables; no conceden herramientas ni autoridad. Los mismos marcadores de
   ingreso gestionado/agente/autopilot que bloquean `approve` bloquean `--answers`.

   Requirements reutiliza la misma rama y worktree, incorpora las respuestas,
   elimina las preguntas respondidas y propone la siguiente versión de parche
   (`1.0.0` → `1.0.1`). El runtime valida la versión, materializa el YAML, lo
   commitea y actualiza `doc_path`/`git_sha`. Solo después del registro cierra la
   decisión anterior, vinculándola a versión, SHA y hash SHA-256 de respuestas;
   el contenido de las respuestas no se guarda en auditoría. Registro y cierre
   comparten transacción SQLite. Si falla la regeneración, la decisión conserva
   su gate y el artefacto anterior sigue registrado. Las nuevas preguntas abren
   una nueva decisión por versión, incluso si repiten texto de una versión previa.

   La opción de la oficina «Resolver todas las preguntas» por sí sola no incorpora
   respuestas al YAML y nunca permite aprobar mientras queden `openQuestions`.
   Cuando la nueva versión no tenga preguntas, ejecutar explícitamente:

   ```powershell
   node dist/cli.js feature approve FEAT-001
   node dist/cli.js feature show FEAT-001 --json
   ```

5. Confirmar `approved` y auditoría `approve_featurespec/pending` seguida de
   `approved`, actor humano. Repetir `feature spec` no lanza otro executor ni duplica
   Features/decisiones. Cambiar el YAML (también un comentario) debe impedir aprobar;
   un commit vacío posterior que conserve el YAML también debe impedir aprobar.
   Una decisión pendiente o expirada también lo impide.

Las pruebas automatizadas usan exclusivamente los fake CLIs de
`server/__tests__/fixtures/fake-requirements-cli.cjs`; Claude realiza la prueba real.

## Artefacto, contrato y reintento

El Brain vive en `project.yaml → brain.path`, relativo a cada checkout. En este
Project es `.softwareagents/brain`. La salida es siempre
`<brain>/features/<FEAT-ID>.yaml`, nunca una ruta elegida por el modelo. El registro
operativo vive en el WorkStore compartido del Git common dir, no en el Brain.
La Task de Requirements usa la key FEAT, tipo `docs` y el rol existente; no inventa
una Task SA ni duplica el estado del worker.

Se reutiliza el parser y esquema SA-013. `acceptance[].ears` es una ampliación
opcional para documentos antiguos; el nuevo paso exige ese campo en **cada**
criterio, además de `given`, `when` y `then`, IDs únicos y `status=draft`. EARS usa
la forma «When/While/Where …, the system shall …», «If …, then the system shall …»
o «The system shall …». La validación es estructural/sintáctica; la calidad y
coherencia semántica corresponden a la revisión humana.

Antes de aceptar una propuesta se serializa sin aliases y se comprueba que el
YAML persistido no supere el límite de lectura de 1 MiB. Una expansión de aliases
que lo exceda cuenta como error de validación y no produce artefacto registrado.

Si falla YAML, esquema o contrato de Requirements, el worker devuelve los errores
al mismo rol en una segunda Execution, con nueva admisión y auditoría. Conserva
la lease de la Task y el worktree limpio. Hay **un solo reintento de validación**;
un segundo fallo deja `FAILED_RETRYABLE` con motivo y sin Feature registrado.
Un fallo de executor o contención no recibe ese reintento de validación. La única
excepción transitoria de credenciales es el mensaje específico de Claude Code
«another Claude Code process is refreshing it»: espera cancelable de 30 segundos
y hasta dos reintentos, cada uno con nueva Execution, admisión y auditoría. Otros
errores de credenciales no se reintentan. La cascada de modelos
SA-103 no se aplica a Requirements: sus verificadores de implementación no
validan este artefacto y no deben multiplicar el límite de dos intentos.

`openQuestions: string[]` conserva el campo estructurado existente. Todas las
preguntas de una propuesta se agrupan en **una Human Decision**, con una clave
estable por contenido y versión, usando el gate existente (una Task no admite gates
simultáneos). Reejecutar no duplica la decisión. Aprobar comprueba además que
no queden preguntas en el artefacto, incluso si una decisión se marcó respondida
sin incorporar las respuestas o hubo un corte antes de abrir el gate.

## Contención y aprobación

Se conserva SA-062: Claude no dispone de Bash/Edit/Write y Codex corre en sandbox
`read-only`. El runtime materializa una propuesta ya validada. La guardia final
compara hashes de archivos versionados, ignorados y no versionados, rechaza enlaces
y cambios de HEAD/rama, y permite en el índice únicamente el YAML esperado.
Cualquier escritura del agente detectada falla y conserva evidencia; no se
revierten cambios ajenos automáticamente. Son defensas para trabajo local
supervisado: el [threat model](security/threat-model.md) conserva sus límites de
aislamiento de SO, escrituras transitorias/rutas fuera del worktree y carreras
frente a otro proceso del mismo usuario.

`approve_featurespec` reutiliza la política SA-019: solo ingreso humano del CLI,
sin flags de actor ni acciones desde el board. Los procesos gestionados/autopilot
se rechazan como agentes. La aprobación compara el fichero de trabajo, índice y
versión de la rama con el contenido del commit registrado. Además exige igualdad
entre el SHA registrado, HEAD del worktree y la ref de la rama, y comprueba decisiones
pendientes/expiradas dentro de la transacción de WorkStore. El `status=approved`
autoritativo es el de WorkStore: no se reescribe el YAML `draft` ni se altera el SHA
revisado para simular una aprobación del agente.

Git, SQLite y JSONL no comparten transacción. Un fallo después del commit Git o
antes de la confirmación de auditoría requiere inspeccionar los registros; no
prueba que la operación no sucediera. Un YAML previo sin registro no se sobrescribe.
Los worktrees sucios y leases pendientes siguen la recuperación/manual review
existentes. Este comando no integra, hace push ni retira worktrees.

## Próximos pasos

| Paso                 | Estado y contrato pendiente                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Requirements Analyst | SA-041: petición → FeatureSpec validado → aprobación humana                                                            |
| Architect            | SA-042: consumir el FeatureSpec aprobado, TechnicalDesign y TaskDAG; conectar la ruta nueva con el importador de Tasks |
| Developer            | Pendiente: ejecutar Tasks y producir implementación/evidencia                                                          |
| Reviewer             | Pendiente: revisión cruzada de los cambios                                                                             |
| QA                   | Pendiente: verificar criterios y pruebas reales antes de integrar                                                      |

El importador histórico [task CLI](task-cli.md) mantiene su ruta
`features/requests/`; la conexión del siguiente paso queda para Architect.

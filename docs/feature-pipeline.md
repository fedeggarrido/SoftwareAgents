# Feature pipeline: Requirements, Architect, Developer, Reviewer, QA y Orquestador (SA-041–046)

El primer paso convierte una petición del operador en un FeatureSpec revisable.
FEAT-001 es la **vista de auditoría en el Command Center**, por decisión del
operador. No incluye diseño técnico ni implementación de esa vista.

## Investigación después de construir (SA-113)

`pixel-agents research review FEAT-001 --mode quick --confirm` compara el código citado
con el FeatureSpec, el TechnicalDesign, cada tarea del DAG y el informe de
investigación previo, si existe junto al request original. Es un comando humano
explícito: nunca se inicia al terminar una build ni desde la oficina. Exige el
ingreso SA-107, rechaza procesos gestionados y muestra la misma estimación, tope y
advertencia de coste que `research run`. Tras verlos, repetir con
`--accept-cost <estimación>,<tope>` y `--confirm`. `--json` devuelve solo metadatos.

Reutiliza los modos `quick|deep`, límites de Operator config, plazo global y
contabilidad de SA-112, incluido el margen fijo del 20% y la asignación por llamada.
Una respuesta puede superar el tope estimado; el corte conserva un informe parcial.
No vuelve a buscar en la web: contrasta las fuentes ya recogidas con el diff.
Antes de lanzar síntesis o reintento, el presupuesto compartido estima **bytes
ASCII / 2 + bytes no ASCII**, redondeado hacia arriba, más 1.024 tokens de framing,
para el sistema compilado (incluido el esquema) y el contexto. Rechaza si esa
estimación alcanza los tokens restantes o agota el coste de entrada disponible,
o si se supera el tamaño máximo por petición. El rechazo indica usar `deep` o
reducir la entrada. No añade llamadas de red ni requiere claves. Sin tokenizer
exacto, esta estimación puede subestimar el consumo real: la cancelación por uso
de tokens reportado en runtime sigue siendo la guarda final.
El fixture quick de revisión con esquema real, metadatos, 60 líneas añadidas y
sin investigación previa usa 17.557 bytes ASCII: ceil(17.557 / 2) + 1.024 = 9.803
tokens, dejando 6.197 para salida. Son tamaños de inputs compilados, no mediciones
del tokenizer de Claude.

La Feature debe tener una run `ready_to_merge` con trabajo integrado y su rama
`sa/FEAT-NNN-integration` presente en el SHA registrado. Sin rama construida se
rechaza antes de lanzar el modelo o escribir informes. El diff compara el SHA base
guardado en la run con el SHA construido; sigue siendo útil después del merge a
main. La lectura del plan conserva íntegra la barrera de `featureDocument` y exige
que esos documentos también coincidan en la rama construida.

Cada criterio de aceptación, sección disponible del diseño y tarea del DAG tiene
una fila: `code_cited` («Código citado: requiere verificación»), `partial`,
`missing` o `not verifiable`, explicación y citas
`file:line` o ids de fuentes. El runtime comprueba referencias y citas literales
contra las líneas del lado nuevo del diff y las fuentes previas revalidadas. Las
filas omitidas o sin evidencia comprobable son `not verifiable`; una fuente externa
por sí sola nunca demuestra entrega. La procedencia del código citado exige una línea
**añadida** en un archivo JS/TS (`js`, `jsx`, `mjs`, `cjs`, `ts`, `tsx`, `mts`,
`cts`), de implementación o tests, fuera de `docs/`, `.softwareagents/` y los
documentos del plan; se excluyen declaraciones `*.d.ts`, `*.d.mts` y `*.d.cts`.
El parser existente de TypeScript exige sintaxis válida y reconoce declaraciones
con implementación, llamadas, asignaciones, retornos y lanzamientos de error.
La cita debe abarcar un token de código reconocido: contexto sin cambios,
comentarios, strings aislados, texto de plantillas/JSX y títulos de tests no
bastan, ni tampoco README sin extensión, `.markdown` o prosa renombrada a `.ts`.
Tampoco califican declaraciones que solo contienen strings, wrappers de tests
vacíos o pendientes, ni funciones vacías.
Las rutas se obtienen de `git diff --name-only -z`, delimitadas por NUL; los espacios y
el quoting de los encabezados de presentación no cambian referencias ni filtros.
Cada patch se obtiene con su ruta literal, sin asociar archivos por esos encabezados.
Los renombrados se comparan como borrado/alta y se analiza el archivo nuevo completo.
Otras extensiones, sintaxis no reconocida, archivos inválidos y binarios quedan
sin verificar. `code_cited` es un puntero para revisión humana, **no prueba entrega
ni pertinencia**. Límite conocido: una cita de código con sintaxis válida puede
ser irrelevante o ineficaz; las heurísticas de texto no prueban comportamiento ni
cumplimiento de criterios. La semántica sigue requiriendo verificación humana.
Las mejoras aparecen como
`proposal` y requieren revisión humana: no crean tareas ni conceden autoridad.

El runtime abre el WorkStore existente en solo lectura, sin migraciones ni
recuperación de leases. No cambia código, Tasks, estado de Feature, decisiones,
índice, HEAD o ramas. El investigador existente recibe todos los inputs como
`untrusted-context-data`, sin herramientas de escritura, lectura, red, shell,
MCP ni delegación. Solo devuelve JSON para validación y publicación por el runtime.

Los informes `.md` y `.json` se guardan junto al almacenamiento operativo de
Features, en el Git common dir:
`softwareagents/feature-research/<Project>/<FEAT>/<UUID>.*`. Quedan fuera del árbol
de cualquier rama, sin modificar exclusiones Git; no afectan las barreras del plan.
El Markdown indenta literalmente el texto del modelo y de fuentes. Logs, salida
CLI y auditoría no contienen el informe ni los inputs; este comando no añade eventos
de auditoría. No sustituye Reviewer, QA, aprobación ni merge humano.

Las pruebas con fixtures están en `server/__tests__/featureResearch.test.ts`; no
llaman a modelos reales ni acreditan la corrección semántica de sus conclusiones.
`researchRuntime.test.ts` fija recuentos BPE independientes obtenidos offline con
tiktoken 0.13.0, vocabulario de 256 bytes y la única unión ` a`, patrón
`[\s\S]+`, sin tokens especiales ni vocabulario descargado: 33.812 bytes densos
son 16.906 tokens; cada extracto normal de 2.400 bytes es 2.400 tokens. Es una
referencia adversaria reproducible, no el tokenizer de Claude. El fixture denso
compilado ocupa 36.719 bytes ASCII: ceil(36.719 / 2) + 1.024 = 19.384 rechaza quick
antes del lanzamiento; dividir por tres lo admitiría con una estimación de 13.264
tokens. Los números esperados de ambos fixtures son independientes de las constantes
de admisión.

## Ideas desde la oficina (SA-109–110)

«Nueva idea» guía una entrevista breve antes de guardar. Tras la idea, pregunta
objetivo, usuarios, alcance, fuera de alcance, criterio de éxito, restricciones y
riesgos. El catálogo y sus ayudas están en `core/src/ideaInterview.ts` para su
reutilización. Cada pregunta exige respuesta o «Decide tú», que se presenta como
un supuesto que el analista debe proponer para revisión humana. La revisión final
muestra todas las elecciones. Volver conserva el texto, incluso al alternar una
respuesta con «Decide tú». Cerrar con contenido pide confirmar el descarte.
El borrador vive solo en el estado del componente hasta guardar.

`SubmitIdea.answers` lleva las siete elecciones estructuradas. El servidor rechaza
ids desconocidos o duplicados, elecciones ausentes y respuestas vacías sin
«Decide tú». Construye las secciones fijas `Idea`, `Respuestas` y `Supuestos`,
con cada línea de texto libre indentada como código Markdown para impedir que
inyecte encabezados o supuestos. El límite de 1 MiB se aplica al archivo completo,
incluidas entrevista y estructura. La auditoría guarda el hash del Markdown final.
Las preguntas adaptativas llegan por Requirements `openQuestions` al panel de
Decisiones al iniciar el flujo mediante el comando existente.

La entrevista se guarda como borrador Markdown pendiente en el checkout
vinculado: `.softwareagents/ideas/<Project>/FEAT-NNN.md`. La identidad del Project
separa borradores al cambiar el manifiesto. Esa ubicación pasa sin cambios por
el validador real de `--request`: archivo regular, sin symlinks/junctions, hasta
1 MiB en UTF-8 y texto no vacío. El servidor elige el primer id libre entre
FEAT-001 y FEAT-999. Omite Features registradas, runs pendientes o históricos,
tareas de requisitos/diseño, ramas `sa/FEAT-NNN*`, FeatureSpecs y requests del
Brain, ideas guardadas y destinos presentes en el índice aunque falten del disco.
La consulta del índice usa `git ls-files --cached -z` con fsmonitor desactivado.
Reservas con creación exclusiva en el Git common dir
(`softwareagents/idea-reservations/<Project>/<FEAT>`) coordinan envíos concurrentes,
incluso desde distintos worktrees. Cada reserva registra UUID del propietario, PID,
fecha, checkout, staging y destino, sin texto del request. El staging exclusivo
`.FEAT-NNN-<owner>.stage` queda fuera de la enumeración. Se escribe, sincroniza y
valida con el lector CLI. Antes de publicar se vuelve a comprobar su realpath
dentro del checkout y su identidad de archivo. Un hardlink publica el contenido
completo atómicamente y falla si existe el destino. Después se retira el staging.
Los fallos manejados retiran el staging y la reserva propios comprobando su
identidad. Las reservas de guardados correctos permanecen para coordinar worktrees.

Los borradores son datos locales, fuera del Brain. Se añade idempotentemente
`/.softwareagents/ideas/` al `info/exclude` del Git common dir, preservando su
contenido anterior y el índice. El guardado normal queda sin avisos. Si falla
esta exclusión, el guardado continúa y el servidor emite únicamente
`[featureIdeas] Local Git exclusion unavailable. Drafts can still be saved.`.
La lista muestra los borradores del checkout vinculado a la oficina. Una reserva
interrumpida conserva su id. Antes de recuperarla manualmente, comprobar que el
escritor identificado terminó y revisar staging/destino en el checkout registrado
y requests del mismo Project en otros checkouts. El PID por sí solo no acredita
identidad tras un reinicio. Si existe un destino completo, conservarlo y retirar
solo su staging verificado. Si falta, inspeccionar el staging antes de retirarlo
y liberar su reserva. Una interrupción entre link y retirada de staging puede
dejar dos enlaces al archivo completo y producir `unsafe_storage` hasta esa
recuperación. Las reservas vacías heredadas se conservan para inspección manual.

El diálogo confirma id y comando exacto, por ejemplo:

```powershell
pixel-agents feature run FEAT-001 --request .softwareagents/ideas/softwareagents/FEAT-001.md --confirm
```

Ejecutarlo desde el checkout indicado sigue requiriendo la confirmación humana
SA-107. Guardar no crea FeatureSpec, Task, Execution ni commit y no concede
autoridad. Features muestra una sección separada «Ideas pendientes · sin
FeatureSpec» con ids y comandos, sin copiar el texto; una idea ya registrada como
Feature deja de aparecer en esa sección. La auditoría solo conserva id y hash
SHA-256, nunca texto, y los errores usan códigos fijos sin excepciones ni contenido.

Usa el WS existente y `ClientMessageContext.privileged` (token de la oficina),
con comprobación de privilegio antes de leer el Project. Sin token el diálogo
explica que es de solo lectura. Sin binding o con `project.yaml` ausente/inválido,
explica qué falta y no guarda. Si se pierde la confirmación, consultar la lista:
los envíos nunca se encolan ni se repiten automáticamente al reconectar. Un fallo
de auditoría posterior al guardado conserva el id y avisa de la confirmación
pendiente, para evitar duplicados por reintento.

Disponible en standalone. En VS Code se deshabilita explícitamente: ese control
aún no tiene un contrato de selección de Project. No toma una carpeta arbitraria
del editor como autoridad. El contexto del servidor transmite esta restricción
al dispatcher compartido, también para WebSockets embebidos con token válido.
El panel muestra carga y errores específicos de ideas con reintento. Las lecturas
y envíos tienen un plazo de 15 segundos. Reconectar solicita otra lectura y
conserva un envío sin confirmar como incierto.

El WebSocket limita cada mensaje a 32 MiB (cabe un layout importado de 256×256) (`WS_MAX_PAYLOAD_BYTES`) antes de
parsear JSON, para clientes con y sin privilegio. Una idea de 1 MiB con caracteres
de control ocupa hasta 6 MiB al escaparse, más el sobre JSON. Se revisaron también
`saveLayout` (editor de hasta 64×64, colores, alfombras, muebles, mascotas y áreas),
`saveAgentSeats` y `saveAreaMappings`. Los fixtures completos de 4096 entradas
caben en ese límite. Los demás mensajes llevan controles escalares o cadenas.
El contrato admite strings y colecciones sin máximo, por lo que mensajes
artificiales o importaciones mayores de 32 MiB quedan sujetos a este nuevo límite.

SA-111 añadirá planificación y
aprobación; ambas pueden consumir estos borradores sin confundirlos con Features.
Las guardas de rutas comparten el límite de `taskPath`: no aíslan a un proceso
hostil del mismo usuario que sustituya directorios entre validación y apertura.

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

## Architect: FeatureSpec aprobado → TechnicalDesign + TaskDAG (SA-042)

Después de aprobar el FeatureSpec, Claude ejecuta desde el checkout principal,
con el paquete construido (`node esbuild.js`) y Operator config existente:

```powershell
node dist/cli.js feature design FEAT-001
node dist/cli.js feature show FEAT-001 --json
```

Equivalente instalado: `pixel-agents feature design FEAT-001`. El comando exige
`features.status=approved`, igualdad del SHA aprobado con HEAD y la ref de la
rama, y contenido idéntico en disco, índice y commit. Revalida antes de lanzar.
No aprueba requisitos ni ejecuta las Tasks importadas (eso corresponde a SA-043).

Reutiliza worker, admisión, cuota, leases, supervisor, contención, compilador y
rol `architect` con `brain_write` efectivo de solo lectura. Usa la misma rama
`sa/FEAT-001-worker` y `.worktrees/FEAT-001` que Requirements, con una Task
operativa distinta `FEAT-001-DESIGN` de tipo `architecture`. La selección usa
`high_reasoning`; la cascada de verificadores de implementación no se aplica.
El contexto incluye el FeatureSpec aprobado y ARCHITECTURE, VISION, RULES y
CONSTRAINTS del Brain (archivos `.md`). Cada archivo ausente se transmite como
`null`, explícitamente ausente; no se inventa contenido. Las entradas siguen
siendo datos no confiables y no conceden autoridad.

La propuesta es un objeto JSON estricto: `components`, `risks`, `body`, `dag` y,
opcionalmente, `adrs: [{title, body}]`. No admite rutas, números de ADR ni status
elegidos por el modelo. El runtime materializa exclusivamente:

- `<brain>/technical-designs/FEAT-001.md`: front matter TechnicalDesign SA-014,
  versión `1.0.0`, status `proposed`, seguido del cuerpo Markdown.
- `<brain>/technical-designs/FEAT-001.dag.yaml`: TaskDAG SA-014 en YAML.
- Opcionalmente `<brain>/adr/NNNN-<título-normalizado>.md`: numeración única por
  Project, cuatro dígitos. El WorkStore reserva los números bajo transacción antes
  de materializar, por encima del máximo del Brain y de las reservas previas.
  Cada reserva queda ligada al Feature y sobrevive a fallos y reintentos.
  El runtime inserta referencias `ADR-NNNN` en el diseño. No sobrescribe
  artefactos previos sin registro.

Las keys son `FEAT-001-T##`. Cada Task exige tipo, tamaño S/M/L, dependencias,
`acceptanceRefs`, `changeZones` (rutas/globs relativos al repositorio, sin escapes)
y `parallelizable` booleano. Las rutas son POSIX relativas, con letras ASCII,
dígitos, `_`, `.`, `@` y `-`; `*` admite caracteres dentro de un segmento y `**`
ocupa un segmento completo (cero o más directorios). Se permite `/` final.
Se rechazan segmentos `.`/`..`, llaves, `?`, corchetes, rutas absolutas, letras de
unidad y backslashes. El prefijo de directorios anterior al primer glob debe
quedar físicamente dentro del checkout; se rechazan enlaces/junctions en él,
incluso cuando el resto de la ruta aún no existe. Se rechaza una zona si su
prefijo fijo es o está dentro de una ruta protegida anclada (`.git/`,
`.softwareagents/`, `AGENTS.md`, rutas SA-063 por defecto o `protectedPaths`
externos del Operator sin comodín inicial), aunque esa ruta no exista. También se
rechazan segmentos protegidos nombrados explícitamente, como `foo/.codex/bar`,
`src/**/.codex/*` o `foo/.git/config`. Los patrones recursivos con `**/` inicial
no invalidan un directorio solo porque podría contener un descendiente protegido:
`webview-ui/test`, `e2e/` y `server/src/**` son válidos con `**/.codex/**` protegido.
Declarar una zona no autoriza esos descendientes: tanto la guardia de zonas del
Developer como la guardia de commit SA-063 aplican todos los patrones fichero a
fichero y rechazan, por ejemplo, `webview-ui/test/.codex/x` dentro de una zona válida.
Una ruta literal existente de directorio o con `/` final incluye descendientes.
Las demás rutas literales seleccionan solo esa ruta; un glob selecciona las
rutas que coincidan. Estos fallos son errores de validación y reciben el
mismo reintento único. `parseTaskDag` y `analyzeTaskDag` validan esquema,
keys únicas y del mismo Feature, dependencias existentes, ausencia de ciclos y
cobertura de **cada AC**. Las zonas y la marca se persisten en la declaración
inmutable; son datos para SA-097, no un permiso para lanzar en paralelo. Los DAG
históricos siguen aceptándose sin esos dos campos.

`testZones?: string[]` declara rutas o globs adicionales para los tests de la tarea.
Es opcional para conservar los DAG históricos; usa exactamente el esquema y las
validaciones físicas y de rutas protegidas de `changeZones`, y forma parte de la
declaración inmutable. Architect debe declarar aquí las raíces de tests que no
sean co-ubicadas ni el espejo `server/src/` → `server/__tests__/`.

Ante una propuesta inválida, devuelve errores deterministas al mismo rol una
sola vez, con otra Execution/admisión. El segundo fallo abre una Human Decision
y deja `FEAT-001-DESIGN` en `WAITING_HUMAN`, sin `FAILED_RETRYABLE` ni diseño
registrado. Repetir el comando no duplica el gate ni lanza otra Execution.
Para incorporar aclaraciones desde ingreso humano:

```powershell
node dist/cli.js feature design FEAT-001 --answers docs/examples/FEAT-001-design-answers.md
```

Ese Markdown debe existir dentro del checkout, ser regular, sin enlaces y de
hasta 1 MiB. Los marcadores de ingreso gestionado/agente bloquean `--answers`.
La decisión se conserva durante la regeneración; solo se cierra al registrar el
diseño y las Tasks, en la misma transacción SQLite, con SHA y hash de respuestas.
Un fallo conserva el gate. No se registra el texto de las respuestas en auditoría.

El runtime verifica las escrituras y los paths staged, crea un commit con trailer
`SoftwareAgents-Execution` y registra en `technical_designs` (migración v8)
`doc_path`, `dag_path`, `git_sha` y `feature_sha`. Conserva el SHA aprobado del
FeatureSpec. Registro e importación reutilizan `WorkStore.importTaskDag` en una
transacción: Tasks sin dependencias pendientes en READY, las demás en DRAFT.
`feature show` incluye diseño y decisiones; verifica el nuevo HEAD registrado y
que el spec aprobado no haya cambiado. Con diseño registrado, `task import` exige
el mismo conjunto completo de Tasks y contenido que el DAG del commit registrado:
rechaza altas, omisiones y cambios locales. El mensaje remite a `feature design`
para cambiar el diseño; la regeneración de un diseño ya registrado requiere un
flujo explícito de revisión, todavía no disponible. Solo los DAG históricos sin
diseño registrado conservan importación aditiva. El orden de Tasks, dependencias,
referencias AC y zonas no cambia el contenido. El reimport idéntico es un no-op y no
altera estados, versiones ni leases:

```powershell
Push-Location .worktrees/FEAT-001
node ../../dist/cli.js task import .softwareagents/brain/technical-designs/FEAT-001.dag.yaml
node ../../dist/cli.js task list --json
Pop-Location
```

Claude comprueba en real los flags de solo lectura de Architect, contexto real o
ausente, cobertura de AC, las únicas rutas creadas, numeración ADR, trailer/SHA,
READY/DRAFT y `0 created` al reimportar. El pipeline no integra ni hace push.
Git, SQLite y auditoría no comparten transacción: un corte tras commit y antes del
registro exige inspección manual; no se sobrescriben los archivos huérfanos.
La migración aditiva v9 añade la declaración completa del DAG registrado y las
reservas ADR por Project/Feature; los diseños v8 conservan sus declaraciones
inmutables como referencia al migrar. Antes de abrir la base v9, actualizar y
reiniciar coordinadamente todos sus
escritores como indica [task CLI](task-cli.md#migraciones-de-la-base-compartida).
Las pruebas automatizadas usan únicamente fake CLIs.

## Developer: Task READY → rama con commits para revisión (SA-043)

Después de aprobar el FeatureSpec y registrar el diseño, desde el checkout
principal, construir `node esbuild.js`. Comando para la prueba real de Claude:

```powershell
node dist/cli.js feature develop FEAT-001 --task FEAT-001-T01
node dist/cli.js feature show FEAT-001 --json
```

Equivalente instalado: `pixel-agents feature develop FEAT-001 --task FEAT-001-T01`.
Sin `--task`, selecciona la primera tarea `code`/`doc` con rol `developer`, o con rol `qa`, `test`
o `qa-author` del DAG en READY o WAITING_QUOTA
que cumple `canStart` (dependencias DONE). Ejecuta **una sola tarea**; no promueve
dependientes ni integra. Si no hay otra elegible, devuelve la referencia de revisión
ya existente. Con `--task` y `review_ref` ya registrado, devuelve la misma referencia
sin volver a lanzar al agente. Una tarea bloqueada, ajena al Feature o sin zonas se rechaza.
WAITING_QUOTA conserva las mismas validaciones de feature, diseño y dependencias;
WorkerLifecycle la devuelve a READY y reevalúa selección y disponibilidad.

Reutiliza worker, selección/cascada SA-103, leases y recuperación SA-026,
compilador y contención SA-062 con `branch_write`, guardia SA-063, commit con
trailer y transición a REVIEW. La rama es `sa/FEAT-001-T01-developer` y el
worktree `.worktrees/FEAT-001-T01`, desde la base declarada del Project o desde
la rama de integración registrada por `feature run` (SA-046).
Antes de crear la rama, el runtime registra el SHA de esa base en
`<git-common-dir>/softwareagents/task-bases/<rama-codificada>.json`. En cada
reintento, incluso al devolver `review_ref`, exige ese registro y que el merge-base
entre la rama y la base del Project coincida con el SHA registrado. Una rama
preexistente sin registro requiere reconciliación humana; no se adopta su HEAD
como base. Todas las guardias y `review_ref.base` usan el SHA registrado.
El contexto incluye el FeatureSpec aprobado, el diseño registrado, la tarea,
sus referencias AC y `changeZones`, siempre como datos no confiables. Se comprueban
SHA, disco, índice, rama y declaraciones importadas antes de admitir y de lanzar.

`feature develop <FEAT-ID> --task <KEY>` permite reintentar explícitamente una tarea
de código en FAILED_RETRYABLE, sin `review_ref`, con las mismas validaciones de
feature, diseño y dependencias. Sin `--task` no selecciona fallos para reintentar.
Para fallos del agente/verificadores, el claim incrementa `attempt` de forma atómica; si el siguiente intento alcanza
`max_attempts`, queda en FAILED_FINAL para revisión humana sin lanzar el executor.
Reutiliza rama, worktree y base registrada. Tras confirmar el cierre de procesos y
adquirir el claim, descarta los cambios fallidos hasta el último commit registrado
en ReviewReport/TestReport o la base si no hay uno. Un HEAD distinto exige
reconciliación humana. Antes de reset/clean inspecciona con lstat y retira cada enlace
sin recorrerlo (incluidas junctions); conserva sus destinos.
Tras un `feature rebase`, el nuevo tip registrado también es una entrada válida
para ese reintento; el historial conserva las referencias a las bases anteriores.

Una infracción de zonas registra `change_zones_exceeded` y todas las rutas relativas
ofensivas, escapadas en JSON, en auditoría y en el motivo de la tarea.
También persiste `missing_test` y `guard:developer_changes` con el detalle saneado
de la guardia. Primero se ofrece la [corrección automática en el mismo intento](#corrección-de-guardias-del-developer-sa-qa-54).
Si también falla, estos rechazos permiten una corrección con `previousFailure`, sin
gastar el presupuesto del agente. Repetir la misma categoría (y el mismo detalle
para guardias genéricas) deja WAITING_HUMAN con `gate: repeated_guard`, conserva
los cambios y detiene `feature run` con exit 3. Requiere intervención humana y un
reset explícito a READY; relanzar el run no abre otro intento.
Los errores de infraestructura del verificador detienen el run sin gastar intentos;
los errores de executor de autenticación, spawn, timeout, lease o workspace abren
un gate humano. No se convierten en FAILED_FINAL por reintentos automáticos.
Cada `cascade_attempt` registra `exitCode` (null solo sin evento finished),
`result` y `reason` en caso de fallo: `guard_rejected`, `infrastructure_error`,
`criteria_tampered`, `runtime_error`, fallo de verificador o del executor.
Un fallo posterior a un finished con exit 0 conserva ese 0; el motivo identifica
la causa sin guardar salida bruta del verificador.
`task list` y `feature show` exponen `last_developer_failure`. El siguiente contexto
incluye `previousFailure` y `allowedScope`: zonas exactas, directorios efectivos,
`testZones` y patrones de espejo permitidos. Son datos no confiables, sin autoridad.

Salvo en el [modo documentación](#tareas-de-documentación-sa-qa-61), el rol pide
un test de aceptación o reproducción antes de implementar. Antes de
verificar, después de verificar y antes del commit, el runtime comprueba el diff
completo contra la base (índice, disco, archivos nuevos e ignorados): solo admite
las zonas declaradas y tests JS/TS `*.test.*`/`*.spec.*` autorizados. Estos tests
deben estar en `changeZones`, ser su espejo `server/__tests__/` de `server/src/`,
el espejo webview comunicado en contexto, o coincidir con `testZones`. Además deben
coincidir con los patrones ejecutados, salvo una excepción explícita `testZones`;
los tests co-ubicados necesitan esa excepción. **Para `core/src/`, los tests van en
`server/__tests__/core/`, conservando el subdirectorio y el nombre de origen con
sufijo configurado (actualmente `.test.ts`)** (p. ej. `core/src/messages.ts` →
`server/__tests__/core/messages.test.ts`). Se permiten las variantes del mismo
nombre que anuncian los patrones de espejo. Este espejo se comunica en
`allowedScope.mirroredTestZones` y `coreTestRule`, incluso sin `testZones`.
No se admiten tests en `core/src/` ni otra raíz `core/`, tampoco mediante una
zona amplia o explícita: no existe runner core. Vitest related de fuentes core
usa el workspace server y sus tests espejo. El sufijo no autoriza rutas ajenas, ni siquiera para
borrar o vaciar suites existentes. Una zona literal que ya
era directorio en el checkout principal, o acaba en `/`, incluye descendientes;
los globs usan la gramática de Architect, incluido `**/` sin directorios.
Las rutas protegidas/configuración/dependencias, enlaces y cambios ignorados se
rechazan. Exige al menos un test no vacío con líneas añadidas; eliminar un test
o modificar únicamente fixtures no satisface el contrato. Cualquier rechazo
conserva el trabajo para inspección y no crea un commit.

Regla efectiva de espejo: se conserva el subdirectorio relativo de `server/src/`
en `server/__tests__/` y el prefijo completo del nombre; el sufijo se deriva del
include del workspace y admite variantes antes de `.test`.
Por ejemplo, `server/src/clientMessageHandler.ts` permite
`server/__tests__/clientMessageHandler*.test.ts`, sin incluir subdirectorios nuevos.
Los globs de fuente conservan su alcance al transformarse; una zona de directorio
permite sus tests espejo descendientes. Los tests co-ubicados siguen quitando
únicamente `.test`/`.spec` para comprobar su fuente contra `changeZones`.

Los verificadores usan los comandos del binding SA-103 de la tarea, o
`defaultVerifier`; sin ninguno, `tsc --noEmit --incremental false`. Se ejecutan
también cuando la cascada está desactivada. Además ejecuta los tests modificados
con Vitest instalado, configuración neutral externa, un worker y HOME/USERPROFILE
aislados, sin caché ni instalaciones. El reporter JSON escribe fuera del worktree:
cada fichero requerido debe aportar al menos un test ejecutado y aprobado. Los
tests y suites añadidos no admiten `skip`, `todo` ni `only`; una comprobación
estática con el parser de TypeScript exige `expect` o `assert` en el cuerpo de
cada test nuevo o modificado. Un test sin recoger o fallido impide el commit.
Los tests que requieren aliases/setup especiales necesitan adaptación explícita;
no se carga configuración del repositorio generada por el agente. QA, Developer y
`vitestRelated` resuelven cada fichero en `server/` o `webview-ui/`, con raíz y
directorio de trabajo del workspace. Los perfiles neutrales reproducen el entorno
Node y la selección de tests de sus configuraciones: globals en server y imports
explícitos en webview. Las tandas mixtas se separan por workspace; una raíz distinta
se rechaza antes de ejecutar comandos. Como SA-103,
esto valida agentes cooperativos y no confina código adversarial en el SO.

La comprobación roja sobre la base no se automatiza en este slice: aplicar tests
nuevos a otra base requiere un árbol separado y contexto de test compatible;
no se revierte código del worktree activo para simularlo. El agente debe declarar
esa limitación y Claude revisa el test y reproduce el rojo cuando corresponda.
Durante SA-043 se ejecutó primero el test de aceptación del nuevo CLI sobre la
implementación base: falló por `Usage` al no existir `feature develop`; después
pasó. La presencia de cambios de test y su ejecución verde no acredita su calidad
semántica ni demuestra el orden temporal de las ediciones.

WorkStore v10 añade `tasks.review_ref = {branch, sha, base}`, visible en
`feature show` (texto y JSON), ligado a la tarea. El commit y registro usan una
clave SA-026 por tarea/diseño: nunca se repite un efecto pendiente o incierto.
Un corte entre Git, SQLite y auditoría exige reconciliación humana; no crea una
rama alternativa ni descarta evidencia. Actualizar/reiniciar todos los escritores
antes de abrir la base v10, como en [task CLI](task-cli.md#migraciones-de-la-base-compartida).

Los subcomandos individuales no crean PRs ni integran. `feature run` puede
integrar en la rama del feature (SA-046); `push_main = deny` siempre.
Por defecto no publica ninguna rama. Solo Operator config externo puede activar:

```json
"developer": { "pushBranch": { "enabled": true, "remote": "origin" } }
```

El runtime resuelve el nombre del remoto en el checkout principal a una URL
explícita, revalida la rama y SA-063 y publica únicamente
`<sha>:refs/heads/sa/<TASK>-developer`, sin hooks ni refspecs implícitos. Ni siquiera
un remoto llamado `main` cambia ese destino. Publicar es idempotente por
tarea/SHA/nombre de remoto; un resultado incierto requiere reconciliación SA-026.
La contención del agente y su pushurl bloqueado se conservan. Un fallo de publicación
conserva la referencia local lista para revisión.

Claude comprueba en real el contexto/flags, tests, commit/trailer, `review_ref`,
main intacto y ausencia de push por defecto; repite el mismo comando y confirma
el mismo SHA y número de Executions. La QA automática solo usa CLIs falsas y
repositorios/remotos Git desechables.

## Actualizar la base de una tarea (SA-QA-36)

Cuando avanza la rama base del Project, el operador humano puede actualizar una
tarea desarrollada sin editar manualmente `task-bases` ni `review_ref`:

```powershell
pixel-agents feature rebase FEAT-001 --task FEAT-001-T03
pixel-agents feature show FEAT-001 --json
```

El comando exige una tarea sin lease en REVIEW o QA, con `review_ref` válido,
rama y HEAD iguales al SHA registrado y su worktree limpio. Incluye archivos
ignorados y no versionados: rechaza los residuos nombrando sus rutas, sin
eliminarlos. Los mismos marcadores de ingreso gestionado que bloquean `approve`
y `--answers` impiden el `rebase` directo. El run autorizado por el operador
puede invocar ese mantenimiento dentro del ciclo SA-046; no hay un flag de actor.

Toma el tip local actual de `project.repo.defaultBranch`, sin fetch implícito.
Prepara el rebase en un worktree separado, sin executors, hooks ni instalaciones.
Un conflicto aborta allí y conserva la rama, el worktree y los registros originales.
Compara `git patch-id --stable` del diff completo `base..sha` antes y después.
Si coincide, mantiene el estado y la vigencia de las aprobaciones de revisión/QA;
los informes y artefactos originales permanecen inmutables y la cadena de rebases
equivalentes vincula su referencia con la actual. Si cambia, vuelve a REVIEW y
las aprobaciones anteriores solo cuentan como historial: exige una nueva revisión.
La equivalencia del patch no sustituye la prueba real sobre la base actual.

Publica rama, índice/archivos del worktree, base confiable y `review_ref`
`{branch, sha, base}` bajo el bloqueo de escritura de WorkStore y compara la
versión de la tarea. Un fallo de publicación revierte Git y el registro y hace
rollback SQLite. Git, filesystem, SQLite y auditoría no tienen una transacción
distribuida: un marcador persistente `.rebase` junto al registro bloquea todos
los consumidores de la base durante la publicación. Si el proceso se interrumpe,
se conserva para reconciliación. SA-046 reconoce los dos estados conocidos del
journal bajo el bloqueo de WorkStore; cualquier edición ajena exige intervención
humana. Los eventos de WorkStore y auditoría `feature_rebase` conservan
SHA/base anteriores y nuevos y ambos patch-id. `feature show` expone la base nueva
en `review_ref`; Developer, Reviewer y QA reutilizan ese registro actualizado.
No integra ni publica ramas.

## Reviewer: revisión cruzada → QA o rework (SA-044)

Desde el checkout principal actualizado, construir `node esbuild.js`. Claude hace
la prueba real sobre la tarea y rama de Developer ya registradas:

```powershell
node dist/cli.mjs feature review FEAT-001 --task FEAT-001-T01
node dist/cli.mjs feature show FEAT-001 --json
```

Equivalente instalado: `pixel-agents feature review FEAT-001 --task FEAT-001-T01`.
La rama esperada es `sa/FEAT-001-T01-developer`. Sin `--task`, toma la primera
tarea del Feature en REVIEW con `review_ref`. Requiere FeatureSpec aprobado,
diseño y declaración inmutables, base confiable, rama y HEAD iguales al SHA
registrado y worktree limpio. Revalida antes de lanzar y antes de persistir.
Un SHA cambiado se rechaza; nunca se revisa silenciosamente otro commit.

El runtime calcula `review_ref.base..review_ref.sha`, sin external diff ni
textconv, con un máximo de 1 MiB; si lo excede, falla sin truncar el contexto.
El Reviewer recibe el diff, los archivos afectados, el FeatureSpec aprobado,
el diseño y la tarea con sus AC y changeZones como datos no confiables. Reutiliza
el worker, leases/recuperación, selección SA-036/090/092, cuota, slots,
revalidación, `agentCompiler` y contención. El rol es `reviewer`, perfil
`read_only`: solo executors con herramientas de lectura sin ejecución de código,
hoy Claude con Read/Glob/Grep, sin Bash, conectores, red ni delegación. Codex queda
excluido también de Reviewer: su sandbox `read-only` conserva shell general y no
hay mediación previa que limite sus comandos a lectura. Detectar `command_execution`
en el stream después de iniciarlo no impide ejecutar código. La exclusión
`code_execution_not_mediated` queda en la selección y su traza; sin candidato
admisible se abre la Human Decision de selección en WAITING_HUMAN, conservando
`review_ref` y la fase anterior para reevaluar. La guardia de hashes de Requirements detecta
escrituras incluso en ignorados; falla conservando evidencia. No acredita un
sandbox de SO para Claude ni evita escrituras transitorias de procesos ajenos.

Agent ≠ Model: entre candidatos permitidos del nivel/capacidad seleccionado,
prefiere un **executor distinto** al del último intento del Developer cuando
su sonda está disponible. Si no hay alternativa disponible y autorizada, usa
el mismo; la razón `cross_executor` o
`same_executor_no_available_alternative`, ambos executors y el rol quedan en
auditoría, `executions.selection_reason` y telemetría sin contenido. Los gates
normales de cuota/concurrencia se mantienen; una espera no habilita un fallback
por cuota. No aplica la cascada SA-103 al Reviewer: sus verificadores de
implementación no validan un informe. El Developer conserva su cascada durante
el rework, preservando los commits anteriores y la base original del diff.

La salida pasa por `extractJsonObject` y el esquema
`core/schemas/review-report.schema.json`. `request_changes` exige un finding
`blocker` o `major`; `approve` no los admite. Cada finding incluye fichero del
diff, severidad, resumen, sugerencia y línea positiva opcional. `acCoverage`
opcional solo admite AC de esa tarea y sin duplicados. Un informe inválido
recibe exactamente un reintento con errores y nueva Execution/admisión; el
segundo fallo devuelve la tarea a REVIEW y conserva `review_ref`.

Un fallo de infraestructura del Reviewer (OAuth, auth, spawn, timeout, cuota o
lease expirado) también conserva REVIEW, `review_ref` y `attempt`, sin consumir
rondas de rework. Solo un ReviewReport válido puede rechazar o aprobar el trabajo.
`task list` y `feature show` exponen `last_review_failure`, con motivo saneado y
fecha del último intento fallido, persistido en los eventos y en auditoría del
worker. `feature review` recupera también tareas históricas en FAILED_RETRYABLE
con `review_ref` válido cuyo último intento era Reviewer; las devuelve a REVIEW
al adquirir el claim, conservando las validaciones de SHA, base y worktree.

Un rechazo válido guarda el informe, limpia `review_ref` y pasa a READY con
`attempt + 1`. El siguiente `feature develop` recibe `reviewFindings` y
`reworkAttempt`, reutiliza la misma rama/worktree y registra un nuevo commit y
SHA. `REVIEW_MAX_REWORK_ROUNDS = 3`: permite tres reworks automáticos; el cuarto
rechazo guarda el informe y abre una Human Decision en WAITING_HUMAN sin otro
incremento. Informe, transición y decisión por tope son una transacción SQLite.
Una aprobación pasa a **QA**, estado existente; QA se ejecuta explícitamente con
`feature qa` (SA-045). La excepción son las tareas doc: pasan a DONE con evidencia
de QA no aplicable, como indica el [modo documentación](#tareas-de-documentación-sa-qa-61).
Reviewer no integra ramas.

WorkStore v11 añade `tasks.review_reports` (histórico con informe, `review_ref`,
Execution y ambos executors) y `executions.agent_role`. El histórico aparece en
`feature show` tanto en texto como JSON; sustituye el comentario de PR con
auditoría `review_report_pending`/`review_report_persisted`. Actualizar y reiniciar
todos los escritores antes de abrir v11 según
[task CLI](task-cli.md#migraciones-de-la-base-compartida). Git y auditoría no
comparten transacción con SQLite: si falta la confirmación de auditoría,
inspeccionar WorkStore antes de reintentar. No se usa `gh`, ni PR, push o merge.

Claude comprueba en real la exclusión de Codex para Reviewer, la selección de
Claude (cruzada cuando Developer usó Codex), flags de solo lectura, informe y
traza, QA tras aprobación y, ante
rechazo, los findings en el siguiente `feature develop`. La prueba automatizada
solo usa CLIs falsas y repositorios Git desechables; la prueba real corresponde
a Claude antes de integrar.

## QA: criterios, comandos del runtime y defectos trazables (SA-045)

Con FEAT-001-T01 ya en QA y su review aprobado, Claude realiza la prueba real
desde el checkout principal, con Operator config autorizada y el build actualizado:

```powershell
node esbuild.js
node dist/cli.mjs feature qa FEAT-001 --task FEAT-001-T01
node dist/cli.mjs feature show FEAT-001 --json
```

Equivalente instalado: `pixel-agents feature qa FEAT-001 --task FEAT-001-T01`.
Sin `--task`, selecciona una tarea del Feature en QA. Exige el último ReviewReport
aprobado para exactamente el mismo `review_ref`, SHA/base/rama y worktree limpio;
revalida antes del spawn y al persistir. No ejecuta Developer ni hace merge o push.

Reutiliza el ciclo de Reviewer/worker, admisión, selección, cuota, lease, reintento
único de informe, compilador y contención. `test_analysis` admite preferencias
propias; los Projects históricos reutilizan el orden `review` si no la declaran. El rol es `qa`, perfil `read_only`:
solo Claude Read/Glob/Grep, sin Bash, conectores, red ni delegación. Se excluye
Codex antes del lanzamiento por `code_execution_not_mediated`, igual que Reviewer:
`read-only` no elimina su shell general. Sin executor admisible, la selección
abre WAITING_HUMAN conservando el SHA aprobado y la fase QA para reevaluar.
El agente intenta romper cada AC asignado mediante lectura y razonamiento sobre
código, diff y resultados; nunca recibe Bash ni autoridad para ejecutar tests.

El runtime deriva un conjunto cerrado de 1–32 tests versionados de
`server/__tests__/`, `webview-ui/test/` y `e2e/`: tests del diff, de `testZones` y de
`changeZones`, incluidos los espejos `server/src/` → `server/__tests__/`
(mismo directorio relativo y variantes con sufijo) y
`webview-ui/src/<ruta>/<nombre>.ts` → `webview-ui/test/<nombre>*.test.ts`.
Para zonas de directorio o glob del webview solo se derivan los espejos de sus
fuentes versionadas; nunca se amplía implícitamente a todo `webview-ui/test/`.
Un directorio completo de tests solo se ejecuta si la tarea lo declara en sus zonas.
Cada fichero se ejecuta con Vitest y JSON reporter neutral, sin cargar configuración
ni reporters del repositorio. Usa el verificador compartido de evals SA-QA-20:
entorno por allowlist, perfiles/caché temporales, mock de os.homedir en Windows,
60 segundos y 1 MiB por comando/informe, terminación del árbol e integridad antes
y después. Solo enlaza las dependencias existentes durante la verificación y
retira su propio enlace sin recorrerlo; no instala dependencias. Un cierre sin
confirmar conserva temporales, enlace, lease y slot para inspección.
Los límites de aislamiento de SO siguen siendo los de [evals](evals.md#límites-de-seguridad).

Las configuraciones neutrales exigen `test.expect.requireAssertions: true` en QA,
evals, Developer test-first y la cascada `vitestRelated`: un test vacío o con su
única aserción en una rama no ejecutada falla.
El setup neutral cuenta también las llamadas ejecutadas a `node:assert` y
`node:assert/strict` (incluidos sus alias sin `node:`), delegando en los originales;
importar el módulo o crear un `AssertionError` no cuenta como aserción.
Configuración, perfiles, cachés e informes del runtime se crean en scratch y se
retiran tras confirmar el cierre.
La integridad nunca excluye nombres como `allure-results` o `.vite`; el diagnóstico
incluye la ruta relativa escapada y distingue «residuo previo a la verificación»
de «cambio durante la verificación». Un residuo previo es fallo de infraestructura:
conserva QA y no consume rondas.

Los resúmenes `commands[{command,result,passed,failed}]` llegan al agente como datos,
sin stdout/stderr. Ejecuta todo el conjunto declarado antes del agente. QA puede
pedir **una** tanda adicional para reproducir resultados, devolviendo únicamente
`{requestCommands: [IDs de commandAllowlist]}`. Solo admite IDs de esos comandos
del runtime, sin duplicados; después la allowlist queda vacía y exige el informe
final. Cada tanda usa nueva Execution/admisión y se añade a la evidencia. No acepta
argv, shell ni comandos nuevos propuestos por el modelo o por el Brain. Fuera de esas
raíces o por encima del límite, requiere acotar/declarar tests compatibles antes
de reintentar. Los e2e se acotan al spec concreto con las condiciones de
[QA author](#qa-author-tareas-de-tests-del-dag-sa-107); nunca lanza una suite completa.

La salida pasa por `extractJsonObject` y `test-report.schema.json`. Exige exactamente
una entrada por AC asignado con `pass|fail|not_tested|deferred` y evidencia no vacía,
comandos idénticos a la evidencia del runtime y defectos con AC, severidad,
resumen y reproducción. Cada AC fallido exige al menos un defecto enlazado.
No admite pass con tests fallidos o AC no probados. `not_tested` conserva QA
sin consumir rondas ni desbloquear dependencias.

Un AC compartido fuera del alcance de la tarea puede marcarse `deferred`, usando
`evidence` para justificarlo. El runtime solo lo acepta si el DAG registrado y
validado asigna el mismo AC a una tarea descendiente (dependencia transitiva) que
aún no está DONE y no es `type: doc`. Revalida esa cobertura al persistir; sin ella lo convierte en
`not_tested` y conserva QA. Con el resto de AC y comandos en pass, un informe con
deferred permite DONE. El histórico `test_reports`, visible en `feature show`,
conserva el AC y su justificación. La QA posterior debe cubrirlo: solo puede
volver a diferirlo si existe otra tarea posterior pendiente que también lo cubra.
`feature qa --task` permite repetir QA tras `not_tested`, conservando los informes
anteriores, la referencia aprobada y las rondas de rework.

Un fail válido crea bugs `<TASK>-D<n>` en WorkStore con `defect_context`: tarea
original, AC, `review_ref` y Execution del informe. Original e informes conservan
la trazabilidad; la tarea vuelve a READY (rework), limpia su `review_ref` y suma
una ronda. El siguiente Developer recibe los defectos y reutiliza su rama/base.
Reviewer y QA comparten las tres rondas de SA-044: al superar el límite se
persisten informe y bugs y se abre WAITING_HUMAN sin otra ronda automática.
Un pass válido deja DONE, con `review_ref` aprobado (lista para merge humano), y
promueve a READY las tareas DRAFT del DAG cuyas dependencias estén todas DONE.
Los bugs son registros de seguimiento del rework de la tarea original; no se
introducen como nodos ejecutables del DAG ni se cierran sin verificación humana.
Repetir un defecto para la misma tarea, SHA y AC con el mismo resumen y reproducción
normalizados (Unicode NFKC y espacios) reutiliza el bug existente. La severidad no
crea una identidad distinta; cada TestReport y su artefacto permanecen como evidencia
independiente en el histórico de la tarea original.

WorkStore v12 persiste `tasks.test_reports` y `defect_context`; antes de abrirla,
actualizar/reiniciar los escritores como indica [task CLI](task-cli.md#migraciones-de-la-base-compartida).
Ubicación alternativa deliberada del artefacto: el **Brain operativo compartido**,
`<git-common-dir>/softwareagents/brain/test-reports/<TASK>/<Execution>.json`.
Cada fichero inmutable contiene informe y vínculos y aparece con `artifact_path`
en `feature show` (texto y JSON). Se elige esta ubicación fuera de los checkouts
para conservar el SHA aprobado y la inmutabilidad de FeatureSpec/diseño: el runtime
no añade commits de informes a las ramas de código o del Feature. No hay informe
versionado en Git. SQLite y filesystem no comparten transacción: un corte tras
escribir el fichero puede dejar un artefacto huérfano; WorkStore es la referencia
autoritativa y nunca se sobrescribe un huérfano automáticamente.

OAuth/auth, cuota, spawn, timeout, informe inválido tras dos intentos, lease perdida,
JSON ausente/vacío o tests omitidos conservan QA y `review_ref`, sin consumir rondas.
`last_review_failure` conserva el diagnóstico saneado del último fallo de revisión/QA;
se limpia en cuanto se persiste un informe válido, se completa Developer con
éxito o la tarea avanza a READY/FAILED_RETRYABLE tras reset o rework. Los fallos nuevos de QA usan `QA failed:` y `qa_validation_failed`. Los lectores
conservan compatibilidad con los fallos históricos etiquetados como Reviewer.
El diagnóstico visible `last_developer_failure` también se limpia tras
completar Developer, Reviewer o QA con éxito. Los eventos y la auditoría conservan
los fallos originales.

Claude comprueba en real los flags, resumen de tests del runtime, TestReport y
artefacto, DONE con review_ref aprobado y T02 READY. Las pruebas automatizadas
solo usan CLIs falsas y repositorios/perfiles desechables. La revisión cruzada,
QA real e integración siguen pendientes hasta que Claude las valide.

### Baseline de comandos runtime (SA-QA-59)

QA compara únicamente los comandos con `result: fail` con el commit base fijado
en `review_ref.base` (la base runtime de la tarea), nunca con el main actual.
Materializa ese commit en scratch con un índice Git privado, sin cambiar refs,
índice ni checkout del operador, y reutiliza `runTaskTest` y sus snapshots,
dependencias existentes y perfiles aislados. Cada comparación comparte el límite
`QA_COMMAND_TIMEOUT_MS` entre preparación y ejecución y respeta la cancelación.
No vuelve a ejecutar comandos pass ni not_tested en base.

La evidencia opcional `baseline: { result, passed, failed, reason? }` conserva el
resultado de base. Solo si también falla y `baseline.failed >= failed` se añade
`preexisting: true` y un motivo con el SHA. Es una comparación por conteos, no por
identidad de aserciones; el agente sigue comprobando cada AC. Un spec inexistente
en base o una comparación no disponible no exime el fallo de la tarea.
El brief explica esta evidencia y la auditoría `qa_baseline` registra cada
comparación, también en la tanda adicional solicitada por el agente.

`validateTestReport` admite pass con fallos exclusivamente preexistentes; los
fallos nuevos y comandos de tarea no ejecutados siguen bloqueando. Exige que el
modelo reproduzca exactamente toda la evidencia runtime, incluidos los campos
opcionales: no puede inventar una exención. Los reports históricos sin baseline
ni preexisting conservan su validación anterior. La revisión real e integración
siguen correspondiendo a Claude.

## QA author: tareas de tests del DAG (SA-107)

`feature develop` enruta los roles declarados `qa`, `test` y `qa-author` al
AgentSpec `qa-author`, perfil `branch_write`. La declaración del DAG no cambia.
Reutiliza Developer: rama `sa/<TASK>-developer`, base registrada, idempotencia,
reintento explícito `--task`, contexto de fallos/rework, cascada y `review_ref`.
El ciclo sigue siendo **READY → REVIEW → QA → DONE**, con Reviewer cruzado y
`feature qa` explícitos. El rol `qa` de ejecución sigue siendo de solo lectura;
es distinto del autor de tests.
El worker rechaza `qa-author` fuera de `feature develop`, para exigir siempre
el contexto validado y las guardias de zonas de Developer.

El brief de QA author incluye solo los AC de `task.acceptanceRefs` y omite el
texto completo del diseño. Conserva reglas del FeatureSpec, tarea, zonas, hashes
y evidencia de rework/fallos. El runtime sigue validando la petición completa;
el recorte de contexto no cambia permisos ni guardas.

La guardia exige simultáneamente las `changeZones`/`testZones` declaradas y las
raíces cerradas `e2e/`, `server/__tests__/`, `webview-ui/test/`. Admite fixtures y
helpers dentro de esas raíces y zonas. Ni siquiera una zona amplia autoriza
cambiar producto, ni se aplican los espejos/co-ubicaciones de Developer al autor.
Un cambio fuera de ellas produce `change_zones_exceeded`. No añadir/ajustar un
test ejecutable produce `missing_test`, visible en `last_developer_failure` y en
el contexto del siguiente reintento. Los helpers solos no satisfacen ese requisito.

Antes de verificar, Developer y QA author aplican `eslint --fix --no-cache` y
`prettier --write --ignore-unknown` solo a los ficheros tocados, tras validar las
zonas y la integridad. Las correcciones forman parte del commit del runtime.
Los comandos usan la raíz del checkout y su configuración/ignore de estilo;
Prettier normaliza también CRLF introducido por escrituras del agente en Windows.
Después ejecutan `prettier --check --ignore-unknown` y
`eslint --no-cache` sobre los archivos tocados existentes (ESLint sobre JS/TS),
también con cascada o verificadores del Operator. Un fallo impide REVIEW.
Los tests Vitest escritos se ejecutan por fichero con el runner neutral aislado;
se conservan las comprobaciones de aserciones y de integridad.

Para Vitest del workspace `server`, si el checkout contiene `esbuild.js` (como
SoftwareAgents), el runner copia el árbol a un snapshot en scratch, excluye `.git`,
`node_modules`, `dist` y el scratch local, enlaza dependencias existentes y ejecuta
`node esbuild.js` antes de Vitest. Así se construyen también los hooks que requieren
los tests, incluso cuando los importan indirectamente. Nunca instala dependencias.
La copia, el build, HOME y las cachés quedan fuera del árbol aprobado; antes de
limpiar se valida y desenlaza la junction. Sin cierre confirmado se retiene scratch.
El diagnóstico de infraestructura queda en la tarea sin liberar su lease; SA-026
debe confirmar el cierre antes de recuperarla, conservando los intentos. Esa
recuperación detiene el run y requiere una nueva reanudación explícita.
Un fallo de preparación/build es infraestructura (`not_tested` en QA), nunca un
fallo de aserción. Repositorios fuente sin esa entrada de build y el workspace
webview conservan el perfil neutral sin build. El coste es una copia completa y
un build por invocación server, incluidos `related`, dentro del mismo deadline
compartido con Vitest; no se reutilizan artefactos entre referencias aprobadas.

Un fallo exclusivamente de Prettier/ESLint recibe un único reintento en el mismo
nivel; si persiste se detiene sin escalar. Los fallos de tipos/tests permiten la
cascada solo con evidencia de fallo de producto. Infraestructura, entorno,
`not_tested` (también e2e) y rechazos de integridad detienen el intento sin subir
de nivel, incluso si otro verificador ya había fallado por producto.
Cada siguiente intento recibe `task.verifierFailures` como datos JSON no
confiables: comando, ficheros y primeras 32 líneas (máximo 4000 caracteres) por
fallo, saneados y con secretos redactados. La salida no se guarda en auditoría ni
telemetría; el motivo persistido identifica `verifier_failed: prettier|eslint|tsc|tests|e2e`
con los verificadores que fallaron.

Para e2e, el runtime deriva el spec concreto del diff/zonas. En specs de
`e2e/tests/standalone/`, usa Playwright directamente, equivalente a
`npm run e2e -- e2e/tests/standalone/audit.spec.ts --workers=1`, con configuración
neutral, `testMatch` exacto, un worker, sin retries ni global setup/reporters del
repositorio. Copia el checkout a scratch, enlaza solo dependencias existentes,
construye CLI (`node esbuild.js`) y webview (`vite build`) allí y usa Chromium ya
cacheado. No instala ni descarga nada. HOME/USERPROFILE/TEMP, build e informes
quedan aislados, con el mismo límite de tiempo/salida y terminación de árbol que
Vitest. Electron/VS Code requiere QA del operador y queda `not_tested` en runtime.
Un spec que termina en verde sin ejecutar ningún paso `expect` falla el verificador.

Si faltan Playwright, Chromium o entradas de build, falla la preparación o no hay
evidencia completa, devuelve `not_tested` con motivo. Eso permite entregar la
autoría a REVIEW, pero QA conserva **QA**, sin consumir reworks ni permitir DONE:
el informe incluye el comando y el motivo, y nunca convierte esa omisión en pass.
La evidencia de comando admite `result: not_tested` con `reason` del runtime.
Los fallos de tests ejecutados sí bloquean el verificador del autor. Los comandos
de QA siguen siendo IDs del runtime, nunca argv propuesto por el agente.

Antes de escribir e2e es normativo leer [Mocking model & rules](../e2e/README.md#mocking-model--rules):
frontera de proceso, scenario builder/mock-claude, JSONL append-only y aserciones
visibles; POST directo de hooks solo para standalone. Al añadir specs se regenera
el inventario. El autor debe documentar si el test falla sobre la base y su motivo
si no es razonable comprobarlo: una tarea de cobertura posterior puede tener ya
la feature en su base; no se retira producto para fabricar un fallo.

Prueba real de **FEAT-001-T05**, por Claude desde el checkout principal con build
actualizado y dependencias T01–T04 ya integradas/reconciliadas:

```powershell
node esbuild.js
node dist/cli.js feature develop FEAT-001 --task FEAT-001-T05
node dist/cli.js feature review FEAT-001 --task FEAT-001-T05
node dist/cli.js feature qa FEAT-001 --task FEAT-001-T05
node dist/cli.js feature show FEAT-001 --json
```

Si el runtime no pudo ejecutar el spec, Claude valida desde un checkout construido:
`npm run e2e -- e2e/tests/standalone/audit.spec.ts --workers=1`.
Esa ejecución manual es evidencia para revisión humana; no convierte por sí sola
un `not_tested` persistido en DONE. Esta implementación se prueba con CLIs falsas;
la prueba real y la integración corresponden a Claude.

## Orquestador secuencial y reanudable (SA-046)

Los gates locales de una tarea (WAITING_HUMAN, FAILED_FINAL, guard repetido,
QA invalid_report o not_tested) la bloquean durante el run actual. El orquestador
continúa secuencialmente con otras tareas que cumplen `canStart`, excluyendo las
dependientes transitivas de las bloqueadas. Cuando no queda trabajo ejecutable,
termina en WAITING_HUMAN (exit 3): `blocked` en JSON y el resumen de texto incluyen
cada tarea bloqueada, su motivo y comando sugerido; las dependientes remiten a
`feature show`. Un nuevo run reevalúa el estado actual, sin perpetuar bloqueos
locales ni fallos históricos superados.

WAITING_QUOTA detiene todo el run inmediatamente (exit 3), pues seguir requiere
cuota. También se conservan los gates compartidos de aprobación del spec,
recuperación SA-026, publicación, rebase e integración. No hay concurrencia ni
resolución automática de decisiones humanas. Si todo termina, se conserva
`ready_to_merge` con merge humano.

Desde el checkout principal del Managed Project en Windows, con build y Operator
config preparados:

```powershell
node esbuild.js
node dist/cli.js feature run FEAT-001 --json
node dist/cli.js feature show FEAT-001 --json
```

Equivalente instalado: `pixel-agents feature run FEAT-001`. Si falta el spec,
añadir `--request docs/examples/FEAT-001-request.md`; sin esa opción se busca
`<brain>/features/requests/FEAT-001.md`. El request queda fijado en WorkStore y
no hace falta repetirlo al continuar. Si ya hay spec aprobado, no hace falta request.

El bucle no usa un LLM para decidir. Lee Feature, diseño y Tasks del WorkStore e
invoca los mismos pasos `spec`, `design`, `develop`, `review`, `qa` y la función de
`rebase`. Requirements propone el spec y se detiene para aprobación humana;
Architect importa el DAG. Selecciona secuencialmente por key entre las tareas que
cumplen `canStart`, y exige además que sus dependencias DONE estén integradas.
Developer enruta `qa`/`test`/`qa-author` al autor de tests existente. Una revisión
`request_changes` o QA con defectos vuelve al desarrollo con el contexto persistido.
Los reintentos de Developer usan únicamente `tasks.attempt`/`max_attempts` del
WorkStore; Reviewer y QA conservan su límite compartido de informes negativos
válidos. Requirements/Architect derivan sus fallos del historial de transiciones
de la tarea desde el último reset explícito a READY. No hay otro presupuesto en
`feature_runs.state`: los contadores antiguos se descartan al reanudar, por lo que
un reset o cambio de base no deja intentos fantasma. Las esperas sin Execution,
los fallos de infraestructura del verificador (build, entorno, timeout) y QA
`not_tested` no gastan intentos del agente. Bloquean la tarea durante el run;
se reanudan explícitamente una vez resuelto el entorno. `FAILED_FINAL`, cancelación,
bloqueo y topes locales tampoco impiden avanzar a tareas independientes. Al agotar
el trabajo ejecutable, el resumen conjunto sale con exit 3. Los fallos globales
conservan su diagnóstico y código de salida. No replanifica ni ejecuta en paralelo.

### Rama de integración y base de tareas

El runtime crea `sa/FEAT-001-integration` desde el tip **local** de `main`, sin
fetch, checkout ni modificación de main. Cada Task DONE se publica allí mediante
fast-forward verificado. Si una tarea completada previamente tiene historia
divergente, prepara un merge con `git merge-tree --write-tree` y un commit de dos
padres; un conflicto impide mover la ref. Nunca ejecuta hooks ni instala paquetes.
La rama de integración debe estar libre de checkouts y sus movimientos externos
requieren reconciliación: el runtime no los adopta silenciosamente.

Las tareas nuevas parten del HEAD integrado en ese momento. Developer, Reviewer,
QA, publicación de rama y `feature rebase` consultan esa base runtime del WorkStore,
en lugar de `project.repo.defaultBranch`. `task-bases` registra el SHA exacto y
`review_ref.base` conserva esa referencia. Si la base avanzó durante REVIEW/QA,
el run invoca el rebase existente: patch-id idéntico mantiene las aprobaciones;
un patch diferente vuelve a REVIEW. Un conflicto detiene el run conservando evidencia.

Antes de admitir trabajo y de finalizar se compara `main` con la base persistida
de integración. Un avance se verifica con `merge-tree` y se publica mediante un
intent recuperable; REVIEW/QA se rebasan después sobre esa integración. Un conflicto
abre un gate humano. Cada lanzamiento, incluidos reintentos de Developer/QA author,
exige que los SHA aprobados de las dependencias DONE sean ancestros del HEAD real;
una rama antigua que no los incluya se bloquea para reconciliación humana.
Las publicaciones rechazan refs simbólicas, usan CAS con `update-ref --no-deref`
y comprueban que `main` conserve su SHA tras cada movimiento.

Tras integrar todas las tareas del DAG, `features.status=ready_to_merge` y el
resumen indica rama y SHA. El merge de esa rama a main sigue siendo humano, tras
revisión cruzada y QA real de Claude. No hay push de la rama de integración.
La publicación opcional de ramas Developer sigue su política externa existente.
El run conserva la obligación y la política de push junto al `review_ref` antes
de avanzar. Fija la política antes de lanzar Developer y la conserva al recuperar
su resultado, aunque cambie la configuración del Operator. Recupera también los
resultados de worker sin push confirmado. Un
push fallido o incierto detiene el run; su clave de idempotencia PENDING exige
reconciliación y nunca se interpreta como publicación completada.

### Gates, estado y recuperación

`pixel-agents task retry <KEY> --reason <texto>` exige ingreso humano (SA-003),
sin excepción de autopilot. Primero reutiliza `task backup` y después aplica un
reset atómico con control de versión. Admite WAITING_HUMAN, FAILED_FINAL,
FAILED_RETRYABLE y QA de una Feature; rechaza DONE, leases y recuperaciones
pendientes. Las decisiones humanas abiertas deben resolverse antes del retry.
Con `review_ref` vuelve a READY y lo limpia para rework del Developer; sin él,
queda FAILED_RETRYABLE. Conserva informes, reinicia `attempt` a cero y guarda el
motivo en `blocked_reason` y en el contexto del siguiente Developer. La auditoría
`manual_retry` identifica al operador humano, motivo y backup. No reinicia el
límite compartido de rondas de rework.

Si la selección QA no contiene tests ejecutables o incluye un test fuera de las
raíces admitidas (salvo `testZones` explícitas), el runtime genera un TestReport
`fail` con la causa y la ruta, sin lanzar al agente. Reutiliza la Execution QA
ya registrada durante la preparación y confirma su cierre sin proceso; después
usa `completeQa`, artefacto y auditoría habituales. Esto conserva los invariantes,
la identidad existente de los defectos y el límite de rondas: vuelve a READY sin
`review_ref`, o escala al alcanzar el tope. No representa fallos de infraestructura.
Un avance posterior a READY/FAILED_RETRYABLE deja de proyectar un fallo histórico
de Reviewer/QA como bloqueo actual; el historial permanece intacto.

Una decisión abierta o expirada o `WAITING_HUMAN` bloquea sus tareas; un QA
`not_tested` bloquea la tarea afectada. La aprobación pendiente del spec detiene
todo el bucle con exit 3. El mensaje identifica qué falta,
remite a `feature show` y da `pixel-agents feature run FEAT-001` para continuar.
Las respuestas de Requirements/Architect se incorporan mediante sus comandos
`--answers` existentes, y la aprobación sigue requiriendo `feature approve`.
El orquestador nunca responde una decisión ni aprueba. `WAITING_QUOTA` también sale
con 3; relanzar el mismo run reevalúa el gate de cuota y selección.

WorkStore v14 añade la identidad de creación del runner a `feature_runs`;
v13 incorporó `feature_runs` y `worker_publications`. Actualizar y
reiniciar coordinadamente los escritores antes de migrar, como en
[task CLI](task-cli.md#migraciones-de-la-base-compartida). Guarda progreso,
intentos, acción activa, rama/HEAD integrado y publicaciones preparadas. Un lock
SQLite por Project/Feature rechaza un segundo run con el mismo PID e identidad
de creación SA-026. Solo un proceso ausente o una identidad distinta permite
recuperar el lock. Identidad ausente o incierta exige reconciliación humana;
no se roba a un runner vivo por antigüedad.

Después de matar el proceso, relanzar el mismo comando espera las leases vigentes
y usa SA-026 para recuperar las caducadas, verificando el cierre de Executions.
No duplica ramas ni resultados ya registrados. Los commits preparados y los
artefactos validados de Requirements/Architect tienen un intent persistente antes
de escribir/publicar; se completan sin otra propuesta del agente. El registro
previo de la actualización de la rama de integración permite reconocer tanto el
SHA anterior como el ya publicado. Un journal de rebase se reconcilia solo contra
sus dos estados conocidos y WorkStore; cambios ajenos conservan el bloqueo.
Git, SQLite y filesystem siguen sin transacción distribuida: una identidad de
proceso no verificable, edición ajena o estado que no coincide exige intervención
humana. Nunca se interpreta esa incertidumbre como éxito.

Cada acción produce líneas `acción tarea: resultado` y auditoría `feature_run`;
el worker conserva sus eventos e informes existentes. Con `--json`, el progreso
va a stderr y stdout contiene únicamente el resumen final, con estado, Tasks,
rama/SHA de integración, mensaje, comando de continuación y código de salida.
`feature show --json` incluye `orchestrator` con el checkpoint persistido.

### Configuración del Operator e ingreso

En `~/.pixel-agents/config.json`, bajo `projects.<project-id>`:

```json
"orchestrator": { "maxConcurrentTasks": 1 }
```

El valor por defecto es 1. Cualquier valor mayor falla antes de ejecutar y remite
a SA-037. El repositorio y el DAG no conceden concurrencia ni autoridad.

Los mismos marcadores de ingreso gestionado/agente/autopilot que bloquean
`approve` bloquean `run`. La excepción opcional para la oficina es la allowlist
SA-003 `companyAutopilot[<checkout-absoluto>].command`: debe coincidir **todo el argv
real**, incluido ejecutable, launcher y `feature run FEAT-001` con sus opciones.
Por ejemplo `["C:/Program Files/nodejs/node.exe", "D:/project/dist/cli.js", "feature", "run", "FEAT-001", "--json"]`,
usando las rutas efectivas del operador. No hay flags de actor ni comodines. La
autorización de run permite su mantenimiento/rebase dentro de este ciclo; no
permite `approve`, respuestas ni merge a main. El board no puede ampliar ese argv.

La batería automatizada usa únicamente CLIs falsas y repositorios/perfiles
aislados; incluye tres tareas encadenadas, gates, rework, exclusión y recuperación.
La prueba que mata el runner en RUNNING requiere el helper Windows de SA-026.
Si el sandbox deniega CIM, usar `SA_SKIP_TASKKILL_TEST=1` y repetir esa prueba fuera
del sandbox antes de integrar. No acredita QA real con cuentas autenticadas.

## Tareas de documentación (SA-QA-61)

Developer acepta `type: doc` con `agentRole: developer` en modo documentación.
Las `changeZones` deben ser `*.md` o estar bajo `docs/`; cada cambio debe cumplir
esas zonas y la guardia de documentación, sin ampliaciones mediante `testZones`
ni espejos de tests. Se conservan las guardias de integridad y rutas protegidas.
No se exigen tests, evidencia de ejecución ni verificadores de tipos, incluidos
los overrides del Operator. Se aplica el autofix y la comprobación de formato
existentes sobre los ficheros tocados (Prettier para Markdown).

El ciclo es **READY → REVIEW → DONE**: la revisión cruzada sigue siendo obligatoria.
Un approve cierra la tarea atómicamente, registra el evento
`QA no aplicable: tarea doc` y auditoría `qa_not_applicable`, y desbloquea sus
dependientes. No hay ejecución QA ni TestReport artificial. `feature run` publica
la rama DONE en integración igual que las demás y conserva la reanudación.

Regla del DAG/Architect: cada AC de una tarea doc debe estar cubierto también por
alguna tarea `code` o de autoría QA (`qa`/`test`/`qa-author`) del DAG. Un AC cuyo
único propietario es documentación produce `doc_only_acceptance` y bloquea la
validación/importación del diseño. No se infiere el significado del AC por su texto.
`deferredCoverage` nunca incluye tareas doc: documentar una conducta no verifica
sus comandos, gates o invariantes runtime. Un descendiente de tests que dependa
de documentación sí puede recibir cobertura diferida.

Los reports históricos no se reescriben: si una QA ya difirió cobertura a una
tarea doc, se requiere una tarea posterior de tests con esos AC, revisión cruzada
y QA real antes de considerar verificada la Feature.

## Panel de features en el Command Center (FEAT-002)

El Command Center incluye un panel de **solo lectura** que muestra las features del
Project seleccionado que construye el pipeline, para seguir `feature run` sin abrir
la terminal ni leer `feature show --json`. El botón de apertura está junto a
Auditoría.

- **Ingreso:** exige el mismo ingreso autorizado y privilegio que la vista de
  auditoría de FEAT-001. No añade permisos, tokens ni flags de actor. Sin ese
  ingreso la petición se rechaza sin devolver datos, y una petición para un Project
  distinto del seleccionado o inexistente tampoco devuelve datos de otros Projects.
- **Solo lectura:** no aprueba, no responde ni cierra decisiones, y no lanza,
  reanuda, detiene ni cancela runs o tareas. No modifica WorkStore, Git, Brain ni
  auditoría, y no lanza procesos. Los comandos de gate se muestran como texto: el
  operador los ejecuta en su terminal.
- **Fuentes:** solo el WorkStore (features, diseños técnicos, Tasks, decisiones y
  checkpoint de `feature_runs`), abierto en modo lectura, y refs/objetos Git locales
  para comprobar la integración en `main`. No lee el Brain, rollouts,
  transcripts ni worktrees. No muestra prompts, salidas de modelo, respuestas del
  operador, stdout/stderr, rutas absolutas, PIDs ni URLs de remotos; los textos
  libres se escapan como texto.
- **Actualización:** no hay push en vivo. El panel refleja el estado al abrirlo y
  al pulsar **Actualizar**; mientras `feature run` avanza hay que actualizarlo para
  ver el progreso. Al cambiar de Project se descarta cualquier respuesta tardía del
  anterior.
- **Orden:** por actividad más reciente (feature, Tasks, decisiones y checkpoint)
  descendente; el empate se resuelve por clave ascendente.

### Qué muestra cada fila

- **Estado:** «fusionada» (`merged`) cuando todas las Tasks del DAG están DONE y
  el HEAD de integración persistido es ancestro de `main`; «lista para fusionar»
  (`ready_to_merge`); «spec en revisión» (`in_review`); «en diseño»
  (`approved` sin diseño); «en desarrollo» (`approved` con diseño y sin
  `ready_to_merge`); cualquier otro valor se muestra como «estado desconocido».
  La detección de integración lee refs sueltas o empaquetadas y objetos sueltos o
  packs SHA-1, sin procesos. Si falta historia local no infiere una fusión.
- **Progreso:** `DONE/total` de las Tasks del DAG importado. No cuentan los bugs
  `<TASK>-D<n>` ni las Tasks operativas `<FEAT>-DESIGN` o de Requirements. Sin DAG
  importado: «sin tareas».
- **Tarea en curso:** la acción activa del checkpoint de `feature run`; si no hay,
  una Task con lease o Execution activa. Paso `develop`, `review` o `qa`. Si hay
  varias, la más reciente y el número de las demás.
- **Gates pendientes:** tipo, Task afectada si la hay, marca de expirado y comando.
- **Integración:** rama de integración y SHA abreviado, solo si existe en el
  checkpoint de `feature run`.

### Gates y comandos

- Aprobación del spec: `pixel-agents feature approve <FEAT>`
- Preguntas de Requirements:
  `pixel-agents feature spec <FEAT> --answers <fichero-de-respuestas>`
- Preguntas de Architect:
  `pixel-agents feature design <FEAT> --answers <fichero-de-respuestas>`
- Espera de cuota y QA `not_tested` que detiene el run:
  `pixel-agents feature run <FEAT>`
- Otros `WAITING_HUMAN`: `pixel-agents feature show <FEAT>`

`<fichero-de-respuestas>` es un marcador literal, nunca una ruta concreta. Con
`openQuestions` pendientes el gate es la decisión de preguntas, no la aprobación.
Una decisión expirada se marca como tal. `FAILED_FINAL`, cancelación o bloqueo sin
decisión abierta no inventan un gate.

### Estados vacío y de error

«sin features» solo aparece si la lectura terminó bien y el Project no tiene
Features. Un fallo de lectura (base no disponible, esquema incompatible, error SQL
o datos inválidos) muestra un estado de error con un motivo saneado, nunca una
lista vacía.

### Límites conocidos

- **Features legacy sin título:** el título y las marcas de tiempo del Feature se
  guardan con una migración aditiva del WorkStore. Los Features registrados antes
  de ella se muestran solo con su clave, y su actividad se basa en Tasks y
  decisiones, hasta que se reescriban.
- **`schema_incompatible`:** el panel abre la base en solo lectura y no la migra.
  Si la base es anterior a la versión que necesita, muestra el error
  `schema_incompatible` (no una lista parcial) hasta que cualquier comando
  `pixel-agents` migre la base. La migración es solo hacia delante: los binarios
  anteriores rechazan una base migrada, como indica
  [task CLI](task-cli.md#migraciones-de-la-base-compartida).
- **Tarea en curso obsoleta:** si el proceso de `feature run` muere, el checkpoint
  puede seguir marcando una acción activa; el panel no inspecciona procesos.
- **Sin paginación:** la lista no tiene límite ni paginación en esta versión.

## Regeneración automática del Developer (SA-QA-65)

Después de la guardia del diff y antes del autofix de formato/lint y los
verificadores, el runtime regenera los archivos derivados en el árbol de la tarea:
si cambia `core/asyncapi.yaml` o `core/src/messages.ts`, ejecuta
`scripts/generate-messages.ts` mediante tsx (igual que `npm run asyncapi:generate`);
si cambia cualquier ruta bajo `e2e/`, ejecuta
`node scripts/generate-e2e-inventory.mjs` para actualizar `e2e/README.md`.
Sin esos cambios no ejecuta el generador correspondiente.

Usa los comandos aislados existentes, con perfiles privados y dependencias
enlazadas, sin instalaciones. El contexto Developer prohíbe editar a mano ambos
archivos generados. Sus cambios se incluyen en el commit automático final del
runtime, igual que el autofix de estilo, sin otro intento del modelo; la auditoría
`generated_autofix` registra salida, cambio y resultado. Se conservan las guardias
de integridad y rutas protegidas; el binding y el inventario se admiten como
derivados de las fuentes autorizadas por las zonas de la tarea.

Un generador que termina con error detiene Developer con comando y diagnóstico
saneado, sin escalada del modelo. Solo la imposibilidad de iniciar el proceso se
clasifica como infraestructura. Los drift checks de CI/pre-push siguen vigentes.

## Corrección de guardias del Developer (SA-QA-54)

Antes de lanzar tsc/Vitest, el paso de precomprobación `guardDeveloperChanges`
retira cachés y residuos conocidos de herramientas con `removeAgentToolCaches`,
comprueba integridad del árbol (incluidos temporales y `.git` anidados), zonas,
raíces ejecutadas de tests y reglas de autoría. No ejecuta código del agente.
También se rechazan directorios nuevos de temporales/cachés (`tmp`, `temp`,
`scratch`, `.tmp`, `.cache`, `__pycache__`, `.pytest_cache` y sus variantes con
sufijo), aunque estén vacíos. Los directorios ya presentes en la base se conservan.
Los repos de fixtures deben vivir bajo `os.tmpdir()` y limpiarse desde sus tests.

Un rechazo permite **una corrección gratuita** por invocación de Developer:
el runtime conserva árbol, ejecutor, modelo, nivel y brief original, añade
`guardCorrection` con regla, rutas, diagnóstico y acción, y abre otra Execution.
No incrementa `attempt` ni registra una ronda de cascada por el rechazo inicial.
La admisión y las comprobaciones de autoridad siguen siendo obligatorias.
Auditoría `guard_correction` registra el antes y el después. Si vuelve a fallar,
se aplica el cómputo de fallo habitual y el gate existente por violación repetida;
no se permiten cadenas ilimitadas de correcciones.

La contención de comandos mantiene sus reglas. Sus denegaciones de escrituras
shell (`protected_write`, `outside_worktree`) indican regla, fragmento detectado
y «usa apply_patch/Edit para escribir ficheros». Claude puede continuar tras el
error del hook; si lo ignora o falta su resultado, conserva el fallo cerrado.
Codex detiene la Execution: una denegación shell de esas dos categorías permite
la misma corrección gratuita, después del cierre confirmado del proceso.
No se corrigen gratis push/config/remote, delegación, fallos de hooks ni otras
violaciones de seguridad. Nunca se amplían permisos ni se modifica la regla.

## Descubrimiento de tests compartido (SA-QA-56)

`server/src/testRoots.ts` lee estáticamente los `include` de ambos configs Vitest
y `testDir`/`testMatch` de Playwright, sin ejecutar TypeScript del repositorio.
Developer (guardia, contexto y espejos), QA y las raíces de autoría QA comparten
esta fuente. La comprobación usa patrones completos: webview es plano y los
specs Playwright pertenecen a `e2e/tests/`. Las excepciones explícitas `testZones`
conservan su comportamiento anterior.

La gramática estática admite strings/arrays literales y `path.join(__dirname, ... )`
para `testDir`. Un config ausente o no interpretable usa los valores actuales como
fallback explícito, listado en `testDiscovery.fallback` del contexto Developer.
`testRoots.test.ts` exige cero fallbacks y compara con los configs reales para
detectar drift. Cambiar la sintaxis de un config exige actualizar parser y prueba.

El brief Reviewer incluye `taskTests: [{file, executed}]` de los tests cambiados.
`executed` significa que coincide con el descubrimiento configurado, no acredita
una ejecución ni un resultado verde. El runtime calcula el flag; el contrato
ordena pedir cambios si alguno es falso, incluso con `testZones` explícitas.

## Preparación QA y bloqueos del entorno (SA-QA-58)

Cada ejecución QA posee sus snapshots, incluida la tanda adicional solicitada por
el agente, sin caché global. Los comandos
sobre el mismo árbol reutilizan copia y build; la comparación por contenido del
origen y del snapshot invalida la copia si alguno cambia. La base fijada tiene
una materialización y sesión separadas. Perfiles, informes y plazos siguen siendo
privados por comando. La limpieza retira enlaces individualmente sin recorrerlos;
un cierre de proceso no confirmado conserva el scratch. `qaSnapshot.test.ts`
registra la reducción de tres copias/builds a una para tres comandos idénticos
(build simulado; mide operaciones, no el tiempo de una QA real).
`qaVerifier.test.ts` compara además dos comandos con builds reales de hooks esbuild:
dos builds independientes frente a uno compartido, y registra ambos tiempos sin
imponer un umbral sensible a la carga. Una segunda invocación debe construir de nuevo.

Un resultado del agente con bloqueo explícito (`environment blocked`, sandbox
denegado o comando no disponible) produce `VerifierInfrastructureError`, incluso
con exit 0: detiene la ejecución y permite reintento del operador sin consumir
intentos. No sustituye una denegación de contención ni exime fallos de assertions.

Antes de lanzar Claude, el worker puede retirar `.oauth_refresh.lock` únicamente
del `executors.claude.configDir` explícito: exige fichero regular con PID conocido,
propietario muerto y ausencia comprobada de otros procesos Claude/Node. Un PID
vivo/reutilizado, formato desconocido, enlace o consulta incierta conserva el lock.
La consulta es conservadora: otro Node también impide retirarlo. La auditoría
registra el intento de limpieza antes de borrar; nunca se mata ningún proceso.

## Cuota agotada y recuperación (SA-038)

Un rechazo `rateLimit` de Claude (`rate_limit_event`) o Codex (`rate_limits`,
`error` o `turn.failed`), un `result.is_error` de Claude o un diagnóstico del CLI
en stderr/salida final con usage limit, rate limit o HTTP 429 produce
`WAITING_QUOTA`, sin consumir `attempt`. No se interpreta el contenido de las
herramientas como cuota. El reset explícito de las ventanas/retry-after prevalece;
si falta, `SOFTWAREAGENTS_QUOTA_BACKOFF_SECONDS` configura la espera (300 s por
defecto). La transición persistida publica `quota.waiting` y `quota.exhausted`
del contrato existente. El sweeper reanuda tras el reset y el orquestador conserva
su parada del run entero en `WAITING_QUOTA`.

El runtime guarda el rechazo por ejecutor en `~/.pixel-agents/executor-quota/`,
bajo admisión de máquina; todas las nuevas admisiones consultan esa evidencia.
`EXECUTOR_QUOTA_FAILURE_THRESHOLD` (2) marca los rechazos consecutivos como
indisponibilidad; la evidencia bloquea nuevos lanzamientos desde el primer rechazo
y caduca automáticamente al reset. No cambia los switches del operador.

Con `modelPolicy.fallbackAllowed`, la selección puede probar el otro ejecutor
permitido, pasando de nuevo por los gates de instalación, autoridad, nivel, cuota
y concurrencia. La nueva Execution conserva la elección en `selection_reason`
y auditoría `quota_fallback_selected`. Una ejecución explícita o de evaluación
no cambia de ejecutor. Solo se relanza automáticamente un árbol limpio y con
cierre confirmado; con cambios pendientes se espera para no mezclar trabajos.

Los fallos transitorios de red/5xx tienen hasta dos reintentos, con espera
exponencial de 1 s y 2 s (tope 10 s), árbol limpio y nueva admisión. No se tratan
como agotamiento de cuota. Se auditan `quota_exhausted` y `transient_retry`, sin
guardar el texto del diagnóstico. Los fixtures de rechazo añadidos son
reproducciones de formato, no capturas acreditadas de una ejecución real.

## Ledger de uso y topes (SA-037)

`pixel-agents usage backfill [--dry-run] [--json]` recupera filas ausentes de
Executions históricas. Exige ingreso humano SA-003, igual que `task retry`.
Antes de escribir reutiliza el backup consistente de `task backup` y audita
intención y finalización. Nunca reemplaza filas existentes. Lee eventos de uso,
modelo y cierre en `runs/<execution-key>.jsonl` y complementa campos ausentes
con los spans raíz SA-095 de esa Execution. No suma ambas fuentes. Omite procesos
sin cierre confirmado y ejecuciones sin evidencia de finalización.
Las filas llevan `source: "backfill"`; el intento histórico, tiempos y contadores
no acreditados quedan en `null`. Solo calcula coste con modelo, contadores y
precios declarados suficientes. `--dry-run` abre SQLite en solo lectura, muestra
las filas propuestas y no crea backup, auditoría ni filas. JSON incluye `entries`,
`skipped`, `backup` y `dryRun`. Un ledger vacío muestra costes `unknown`, incluso
si hay tareas DONE. Repetir el comando no duplica ni modifica filas.

Cada Execution cerrada por el worker registra una fila idempotente en
`usage_ledger` del WorkStore (migración aditiva v16). Incluye tokens observados
por SA-095, duración de reloj, intento, executor, modelo/nivel, caché, coste USD
estimado con los precios declarados y snapshots de cuota disponibles. Los datos
ausentes son `null`; no se deducen precios ni contadores. También se registra el
uso de ejecuciones fallidas y canceladas. El ledger persiste independientemente
de la rotación del JSONL de telemetría; solo el backfill humano explícito importa historia.
La recuperación SA-026 también conserva una fila por Execution cerrada: si murió
el consumidor de telemetría antes de guardar el ledger, sus contadores quedan
desconocidos. Nunca contabiliza como cerrada una ejecución cuyo proceso siga
sin cierre confirmado.

`pixel-agents task list --json` añade `usage` por tarea.
`pixel-agents usage [--feature FEAT-001] [--day YYYY-MM-DD] [--json]` consulta
sin lanzar, sondear ni migrar la base. JSON contiene `total`, `byTask`,
`byFeature` y `byDay` del Project actual. El día es UTC de inicio de Execution.
`costPerResolvedTaskUsd` divide el coste total del ámbito entre sus tareas
actualmente DONE; sin tareas resueltas es `null`. El cache hit rate divide los
tokens leídos de caché entre los tokens de entrada, sin promediar porcentajes.
Un coste o contador desconocido mantiene desconocido su agregado.

Los topes opcionales viven en `projects.<id>.budgets` de la config del operador;
véase [referencia de config](executor-selection.md#topes-de-uso-sa-037).
El límite de tiempo cancela mediante el handle del executor y drena sus eventos.
Solo tras confirmar el cierre se libera la ejecución y se abre la decisión
«¿ampliar presupuesto?», dejando la tarea en WAITING_HUMAN. Un cierre incierto
conserva lease/slot para recuperación SA-026. Los límites de intentos, coste USD
y tokens por tarea, y tokens diarios del Project impiden nuevas admisiones.
Los topes por tarea suman el ledger entre roles, niveles y días; desconocidos no
cuentan. Responder la decisión no modifica la config:
si el tope sigue alcanzado, vuelve a bloquear. No activa concurrencia 2 en
`feature run`; admisión y executor-slots mantienen sus responsabilidades.

## Principal Product Designer — SA-105, fase 2

La fuente de verdad del rol es [product-designer.md](agents/product-designer.md).
El digest estable `phase2/v2.0.0` vive en `server/src/designerPrompt.ts`: incluye
las diez preguntas UX, los antipatrones de la sección 12, rúbrica de aspecto IA,
WCAG 2.2 AA y la prohibición de inventar validaciones. AgentSpec usa `read_only`
y capability `review`; Claude recibe solo Read/Glob/Grep (Read abre los PNG).
Codex queda excluido por el mismo límite de herramientas que Reviewer/QA.

Ingreso humano explícito, fuera de `feature run`:

```sh
pixel-agents design review
pixel-agents design review --views office,features,audit,backlog,hud --json
```

En el checkout, compilar primero CLI y webview (`node esbuild.js` y
`npm run build:webview`) y usar `node dist/cli.js design review`. Requiere Project
vinculado, Claude permitido en la configuración del operador y Chromium de
Playwright ya disponible en `PLAYWRIGHT_BROWSERS_PATH`. El comando no instala
dependencias ni navegadores. No ejecutarlo desde un worker o un Agent.

El runtime arranca un proceso con HOME/USERPROFILE/APPDATA/TEMP privados, un
servidor standalone de fixture que sirve la SPA compilada del árbol de la tarea,
en 127.0.0.1 y puerto efímero. El fixture de protocolo suministra el Project demo,
HUD y backlog; Features tiene estados vacío/error/poblado y Auditoría vacío/error. No conecta
WorkStore de producción, watchers, hooks ni handlers de operador. No hay tokens
en la URL. Captura las cinco vistas a 1440×1000 y 390×844: dieciocho PNGs base
y capturas adicionales de interacción por defecto.
Se añaden estados poblados con feature/tarea y capturas hover/focus-visible de
botones de toolbar y panel. Se verifica el pseudoestado antes de capturarlo;
controles ausentes o estados no activados quedan `not_tested`. Las capturas de
interacción no acreditan contraste no textual ni accesibilidad completa.
El servidor y Chromium se cierran en finally; el timeout solicita cancelación y
espera el cierre antes de recurrir a terminar el proceso.

Por cada captura, el runtime lee getComputedStyle de texto DOM visible y calcula
luminancia sRGB WCAG (4.5:1 normal, 3:1 grande). Guarda pares, ratios y umbrales en
JSON. Transparencias, imágenes/gradientes, canvas, oclusión y contraste no textual
no acreditan accesibilidad completa; combinaciones no resolubles quedan sin medir.
Un navegador ausente o un fallo de navegación es fallo de infraestructura y no
produce aprobación. Las capturas son fixtures de la UI real, no evidencia de los
datos ni de las operaciones de la oficina del operador.

`core/schemas/design-report.schema.json` valida verdict, findings
(severity/screen/area/problem/principle/fix), siete puntuaciones enteras 1–5 y
validations (kind/tool/result/evidence). Un blocker/major o un contraste fallido
impide approve. El runtime reemplaza las validations del modelo por su propia evidencia;
no se acepta contraste atribuido al modelo, evidencia vacía ni informe sin captura.
Se guardan `report.json`, `evidence.json`, PNGs y contrastes bajo
`<Brain>/design-reviews/<uuid>/`; auditoría registra inicio, resultado o fallo.
Solo el runtime escribe; el diseñador devuelve su informe como resultado.

Pruebas desde server: `npx vitest run __tests__/designer.test.ts
__tests__/designCapture.test.ts` (compilar antes). La prueba de capturas levanta el
servidor real y Chromium; solo omite con motivo explícito si no puede lanzar el
navegador. La prueba del comando usa un executor fake y no lanza CLIs de IA.

### Dirección artística y decisión humana (SA-028)

```sh
pixel-agents design direction --json
# Responder en Decisions con el id exacto de una opción (ingreso humano autenticado).
pixel-agents design apply-direction --decision <id> --json
```

Ambos comandos exigen ingreso humano y capturas reales del runtime. El rol sigue
siendo de solo lectura: devuelve datos estructurados; el runtime escribe únicamente
`docs/design/**` y declaraciones del primer `:root` de `webview-ui/src/index.css`.
No añade dependencias, cambia lógica, aprueba su propuesta ni integra.

`ArtDirectionProposal` exige diagnóstico, al menos tres alternativas con nombre,
estilo/influencias, personalidad, composición, estrategia cromática, tipografía e
iconografía, ventajas/limitaciones/riesgos, encaje y complejidad; recomendación e
inconvenientes. La matriz contiene seis enteros 1–5. El runtime reemplaza cualquier
total del modelo por la suma ponderada: adecuación 25, usabilidad 20, accesibilidad
15, personalidad 15, coherencia/escalabilidad 15 y viabilidad 10 (resultado 1–5).
Heurística deliberadamente simple: normalizar mayúsculas, acentos y puntuación de
estilo/composición/estrategia cromática; dos ejes idénticos entre dos propuestas
exigen reexplorar **una sola vez**; otra coincidencia falla. No garantiza diversidad
semántica: la comparación artística final corresponde al humano.

Se crea `sa/design-<uuid>` en `.worktrees/design-<uuid>` desde HEAD. El checkout
origen permanece intacto incluso si está en main. Los tres documentos son borradores
sin commit y la HumanDecision «Dirección artística» contiene alternativas,
recomendación y rutas de capturas/propuesta. La respuesta no ejecuta el diseño:
`apply-direction` comprueba decisión contestada, autor humano y opción válida,
y crea **otra rama de revisión** con los documentos y tokens. Claude revisa,
prueba e integra por el flujo habitual; ningún comando hace merge ni push.

La aplicación documenta armonía, roles, escalas y combinaciones prohibidas; las
aprobadas referencian tokens HEX opacos. El runtime calcula cada contraste WCAG
(4.5 texto normal; 3 texto grande/no textual), rechaza incumplimientos y anota
ratios y umbrales en `color-system.md`. Añade equivalentes OKLCH calculados desde
los HEX sRGB. Solo reemplaza nombres existentes en `:root` (`--color-*` y los
demás tokens del proyecto); rechaza nombres nuevos sin consumidores. Valores CSS
con declaraciones, URLs o funciones se rechazan.

### Design review entre Reviewer y QA

`feature run` revisa tareas cuyo DAG declare `needsDesignReview: true` o changeZones
en `webview-ui/`, incluidas tareas doc marcadas explícitamente (no se cierran antes
del gate de diseño). Las demás conservan su ruta habitual a QA o cierre documental.
Después del Reviewer aprobado,
prepara un snapshot privado del árbol de Developer, compila CLI/SPA con dependencias
existentes (sin instalar) y pide un DesignReport con sus capturas. El cargador runner
de Vite evita cachés en junctions; HOME y temporales del build son privados. Los
fallos de infraestructura bloquean con decisión humana. HEAD, limpieza y versión
de tarea se comprueban antes y después de ejecutar el rol.
Una aprobación vale solo para ese SHA; un rebase/cambio obliga a revisar de nuevo.

`request_changes` guarda findings y capturas en el historial persistido del runner,
retira `review_ref` atómicamente y devuelve la tarea a READY. Developer recibe ese
historial, corrige y vuelve por Reviewer → Designer → QA. Cada finding del bucle
debe tener `id` estable; un major nuevo sin regresión requiere `majorJustification`.
Un minor/nit ya aceptado solo puede subir con `regression: true` y justificación
explícita. Cada ronda recibe todos los findings anteriores.

Operator config por Project permite `orchestrator.designMaxRounds` (default **3**)
y `orchestrator.designMaxTokens` (default **100000**, coste en tokens de entrada +
salida reportados por el Executor; no estimación monetaria). Se reserva la ronda
antes de ejecutar y se persiste consumo observado. Al alcanzar un límite se
cancela/escala, con rutas de capturas anteriores y posteriores en HumanDecision.
El CLI comunica uso al final: el límite evita otra ejecución, pero no garantiza
evitar sobrepaso dentro de la llamada en curso. Uso desconocido o crash pendiente
falla cerrado y exige reconciliación humana. Reanudar o responder una decisión no
resetea presupuestos ni aprueba hallazgos automáticamente. El diseñador no responde
decisiones y nunca hay bucle infinito. Los límites de Reviewer/QA siguen vigentes.

## Investigador fase A (SA-106)

Ingreso humano explícito:

```sh
pixel-agents research run --question "¿Qué evidencia existe?" --depth quick --source https://example.org/article --json
pixel-agents research run --question "Pregunta" --since 2026-01-01 --source https://www.reddit.com/r/example/comments/abc/title/
```

El runtime recopila primero usando pregunta y fuentes semilla del operador; el modelo
no planifica consultas ni recibe credenciales. Después ejecuta una única síntesis con
AgentSpec `researcher`, `read_only`, exclusivamente con Claude autorizado y **cero
herramientas**, sin shell, red, MCP ni delegación. SA-102 delimita pregunta y SourceItems
como JSON no confiable; las instrucciones dentro de títulos, autores o extractos no
conceden autoridad. Ningún adapter ejecuta contenido, scripts ni subrecursos.

En `~/.pixel-agents/config.json`, bajo `projects.<project-id>`, configurar:

```json
{
  "autonomyLevel": "A0",
  "allowedExecutors": ["claude"],
  "research": {
    "maxSources": 12,
    "maxTokens": 16000,
    "maxSeconds": 120,
    "search": { "endpoint": "https://provider.example/search", "apiKey": "OPERATOR_SECRET" },
    "reddit": {
      "clientId": "APP_ID",
      "clientSecret": "OPERATOR_SECRET",
      "userAgent": "my-research-app/1.0 by operator"
    }
  }
}
```

`search` y `reddit` son opcionales. Sin proveedor contratado, la búsqueda web requiere
`--discover`; también se admiten URLs explícitas. El proveedor configurable recibe GET con `q` y Bearer opcional;
debe devolver `{ "urls": ["https://..."] }`. No se scrapean buscadores. La lectura web
acepta HTTP(S) sin credenciales, texto/HTML; usa fetch nativo con transporte fijado a
DNS público validado y TLS normal. Rechaza redirecciones, localhost, IP privada/reservada
y resoluciones mixtas; máximo 1 MiB de respuesta y 10 s por petición, dentro del plazo
global. Extracción conservadora de texto, título, autor y lenguaje; no ejecuta JavaScript.
Algunas páginas legítimas que redirigen o requieren JavaScript no estarán disponibles.

Reddit conserva OAuth app-only cuando hay credenciales del Operator config. Sin ellas
usa JSON público: `/search.json`, `/r/<sub>/search.json` y comentarios `.json`, con
User-Agent identificable, intervalo de 6 s compartido por proceso y suspensión de una
hora tras cualquier fallo (incluido 429), sin reintentos ni solicitud de OAuth.
Normaliza hilos y comentarios con autor, canal, fecha y puntuación.
Pausa con cabeceras `x-ratelimit-*`, espacia peticiones y suspende el adapter tras errores
(incluido 429); nunca reintenta en bucle. No expone token ni secretos en contexto,
informes o auditoría. El operador debe tener acceso autorizado a la API/proveedor.

`ResearchAdapter` declara `id`, `kinds`, `search` y/o `fetch`. `ResearchAdapters.register`
acepta módulos externos sin modificar el núcleo; fixture `exampleAdapter.ts` lo demuestra.
La composición CLI registra web y Reddit. Cada resultado se valida contra SourceItem
y su hash SHA-256 del extracto; máximo `RESEARCH_EXCERPT_CHARS` (4000), no obras completas.

ResearchReport exige findings con tipo fact/opinion/anecdote, motivo y referencias
existentes; referencias inexistentes fallan cerrado. Confianza high/medium requiere dos
fuentes con extractos diferentes, autor/canal identificable distinto **y** dominio
distinto; esta heurística conservadora rebaja a low con motivo si no hay independencia
demostrable. No garantiza independencia editorial ni verdad semántica. Contradicciones
también citan fuentes. Citas exactas, atribuidas y limitadas a `RESEARCH_QUOTE_CHARS`
(300 caracteres acumulados por fuente). La bibliografía la adjunta exclusivamente el
runtime con metadatos normalizados. El resumen describe alcance; afirmaciones de
contenido deben ir en findings citados. Evidencia insuficiente es un resultado válido.

SA-112 aplica los presupuestos y la confirmación de coste descritos abajo.
Al agotarse el tiempo, los tokens o el coste, conserva fuentes y lagunas como entrega
parcial. Si falta uso de tokens descarta la síntesis y registra la laguna. `--since`
excluye fuentes sin fecha de publicación verificable. Los fallos de recopilación,
descubrimiento y síntesis producen lagunas con diagnósticos fijos sin contenido externo.

Brain guarda `research/<uuid>.json` y `.md` (datos literales protegidos contra markdown
inyectado), auditados como `research_run` started/completed/partial/failed, sin contenido.
`research/cache/<sha256>.json` reutiliza normalización idéntica por adapter, referencia,
hash del extracto y día UTC de recuperación. Se vuelve a consultar el origen para
detectar cambios; no es una caché HTTP ni evita consumo de red. Nada de esto integra
ramas ni concede aprobación de producto.

Fase B parcial (sin credenciales): arXiv (Atom), Semantic Scholar (Graph API) y Open
Library (search + works) permiten buscar papers y libros. Ejemplo:
`pixel-agents research run --question "evidence synthesis" --kinds paper,book,web --json`.
Sin `--kinds` se consideran todos los adapters registrados, dentro del presupuesto.
Los servicios de papers se espacian al menos 3,1 s por servicio en este proceso;
un error suspende nuevas peticiones a ese servicio durante una hora, sin reintentos.
Semantic Scholar usa un User-Agent identificable y no necesita clave; su cupo público
es compartido y puede responder 429 (se registra como laguna).
Todos usan researchHttp y sus límites y protección SSRF. Solo se leen metadatos,
abstracts y descripciones/primeras frases públicas, nunca PDFs ni obras completas.
Venue/editorial se guardan en `channel`, DOI/ISBN en `citation`; años sin fecha
precisa se representan como 1 de enero. Extractos limitados a 4000 caracteres y
citas acumuladas a 300 por fuente. Tests con fixtures, sin red real.
Referencias: [Semantic Scholar API](https://www.semanticscholar.org/product/api),
[Open Library search](https://openlibrary.org/dev/docs/api/search).

SA-108: descubrimiento sin clave con `pixel-agents research run --question "Pregunta"
  --discover --kinds web,thread,video --depth quick`. El scout `web-scout` es Claude
exclusivamente (Codex no ofrece búsqueda controlable sin shell), `read_only`, solo
WebSearch, sin WebFetch, archivos, shell, MCP ni delegación. Se lanza con sistema
propio, cwd privado, `claudeMdExcludes: ["**"]`, `autoMemoryEnabled: false` y
`--disable-slash-commands` para excluir instrucciones, memoria y skills. No usa
`--bare`: ese modo no admite el login de suscripción. Conserva OAuth y los hooks
del runtime, con settings sources vacíos y MCP estricto. Rechaza un CLAUDE.md
gestionado local porque no se puede excluir. Requiere un CLI compatible y conserva
su techo de seis turnos. El fallo del scout conserva un informe parcial.
El único contexto de tarea es la pregunta pública del operador. No incluir
secretos ni datos privados en ella. El scout devuelve JSON estricto con hasta
min(12, maxSources) candidatos (4 en quick), URL HTTP(S) sin credenciales, título
y motivo cortos. Se rechaza texto adicional. El runtime descarta títulos y motivos,
descarga las URLs con researchHttp y etiqueta todos los SourceItems como
untrusted-external. El texto del scout no llega al Researcher ni al Brain. Fuentes,
tiempo global y tokens observados se comparten con síntesis, también al reintentar.
El proveedor WebSearch sigue siendo una frontera externa; una URL puede transportar
datos de la pregunta. WebFetch está deshabilitado: si se habilita en el futuro,
puede exfiltrar datos por URLs y debe conservar la regla de contexto sin secretos.

YouTube sin clave: `pixel-agents research run --question "Pregunta" --kinds video
  --source https://www.youtube.com/watch?v=abcdefghijk`. También acepta candidatos del
scout. Consulta el player IOS (fallback ANDROID) y subtítulos públicos JSON3 mediante
researchHttp, nunca vídeo ni página watch; sin subtítulos se descarta con motivo.
Es una API no oficial, como la utilizada por yt-dlp, y puede romperse. Prefiere
pistas manuales en el idioma solicitado o inglés antes de recurrir a ASR.
SourceItem video incluye título, canal, fecha disponible y transcripción acotada
a los mismos 4000 caracteres; citas siguen limitadas a 300 por fuente. Cambios en
HTML, restricciones regionales, consentimiento o bloqueos públicos pueden impedir
recuperar evidencia. No hay evasión de acceso ni garantía de disponibilidad.

TODO fase B: Google Books opcional y podcasts.
La investigación posterior al plan pertenece a SA-113.

## Investigación previa al plan (SA-112)

`research run` conserva la recopilación, los adapters, el scout SA-108 y la síntesis
existentes. El ingreso exige el token y la prueba de servidor de SA-107. Los marcadores
gestionados deniegan la operación incluso cuando hay token y confirmación de coste.

Los límites se configuran por Project en Operator config, bajo
`projects.<project-id>.research.modes.quick` y `.deep`.

| Modo  | Fuentes | Tokens observados | Tiempo máximo | Tope estimado USD |
| ----- | ------- | ----------------- | ------------- | ----------------- |
| quick | 4       | 16000             | 180 s         | 1                 |
| deep  | 24      | 100000            | 1800 s        | 10                |

Cada modo admite `maxSources`, `maxTokens`, `maxSeconds` y `maxCostUsd`. Los campos
históricos al nivel de `research` acotan ambos modos. Los techos absolutos son 100
fuentes, 1000000 tokens, 1800 segundos y 1000 USD estimados. Defaults y techos viven
en `server/src/constants.ts`. `--depth standard` se conserva como alias de deep.

Antes de recopilar, escribir o lanzar un modelo, el comando muestra estimación, tope
y una cadena `confirmation`. La estimación conservadora aplica 15 USD por millón al
presupuesto de tokens; los supuestos son 6 USD por millón de entrada y 15 de salida.
El gasto acumulado usa el coste declarado por el CLI al terminar cada llamada.
El tope es una estimación a precios API y una sola respuesta puede superarlo
ligeramente; la confirmación y el informe lo indican en español. El comando
requiere `--accept-cost <confirmation>` con ambos importes exactos, además del ingreso
humano. Un cambio en esos importes exige otra confirmación.

El CLI de Claude comprueba su presupuesto después de recibir cada respuesta y puede
superarlo. Antes de cada llamada (scout, síntesis o reintento), el runtime resta del
presupuesto restante un margen fijo del 20% del tope total, definido por
`RESEARCH_BUDGET_HEADROOM_FRACTION`. Esa asignación llega al CLI como
`--max-budget-usd` mediante `researchBudget.maxCostUsd`. Si no queda una asignación
positiva, no inicia otra llamada. El margen reduce el riesgo de sobrepaso sin
garantizar un máximo estricto. Coste ausente o inválido se contabiliza como toda la
asignación de esa llamada, también si falla o se interrumpe. Alcanzar el tope o
agotar el margen conserva un informe parcial con gasto y motivo de parada, sin
recortar un sobrepaso observado. Los hallazgos ya validados se conservan.
`--discover` ejecuta el scout, recopila sus URLs y sintetiza mientras queda presupuesto.
El precio elegido tampoco constituye una cotización de facturación.
La limitación de Claude Code está documentada en su guía del bucle de agentes.
[Claude Code](https://code.claude.com/docs/en/agent-sdk/agent-loop#budget-headroom),
[precios API](https://platform.claude.com/docs/en/about-claude/pricing).

Para asociar evidencia a un borrador guardado en la oficina, el humano ejecuta
explícitamente el comando con `--idea FEAT-001 --question "Pregunta pública"`.
La pregunta pública es explícita. El borrador completo llega únicamente a la síntesis
en el envelope JSON no confiable. Ejemplo de consulta de los importes antes de lanzar

```sh
pixel-agents research run --idea FEAT-001 --question "Alternativas y riesgos" --mode quick --discover --confirm
```

La primera invocación muestra los importes y se rechaza por falta de `--accept-cost`.
Se repite con esa opción y `--confirm` al final. Todas las etapas son explícitas.

El informe estable vive junto al borrador en
`.softwareagents/ideas/<project-id>/FEAT-001.research.md` y `.research.json`.
Un lock exclusivo serializa ejecuciones para una misma idea. Un cierre abrupto deja
el lock para inspección del operador. El histórico sigue en `Brain/research/<uuid>`.
El Markdown agrupa alternativas, tecnologías, riesgos y buenas prácticas, con fuente
por hallazgo y lagunas explícitas. Texto externo, URLs y títulos son bloques literales.
El JSON conserva procedencia externa, estado parcial, costes y hash del borrador.
El JSON se publica atómicamente y es la fuente autoritativa para el plan.

`feature run FEAT-001 --request .softwareagents/ideas/<project-id>/FEAT-001.md`
resuelve el informe hermano si existe, comprueba el hash del borrador y revalida
fuentes y hallazgos. Requirements recibe exclusivamente el handoff acotado existente,
separado en `research.result` dentro de `untrusted-context-data`. Los campos `request`
y `answers` conservan los datos humanos. El informe completo y los archivos handoff
se rechazan como petición o respuestas. Copiar el Markdown conserva su marcador de
procedencia externa. Los cambios del borrador invalidan el informe asociado.
Leer el informe conserva los gates de FeatureSpec y del plan.

Logs y auditoría contienen identidad, estado y metadatos de coste. `--json` devuelve
metadatos y ruta. El texto del informe se consulta en sus artefactos.

## Próximos pasos

| Paso                 | Estado y contrato pendiente                                                     |
| -------------------- | ------------------------------------------------------------------------------- |
| Requirements Analyst | SA-041: petición → FeatureSpec validado → aprobación humana                     |
| Architect            | SA-042: FeatureSpec aprobado → TechnicalDesign y TaskDAG validados e importados |
| Developer            | SA-043: una tarea READY → rama y `review_ref`; tests salvo tareas doc           |
| Reviewer             | SA-044: ReviewReport persistido, executor cruzado y rework acotado              |
| QA                   | SA-045: TestReport, defectos trazables, DONE y dependientes READY               |

El importador [task CLI](task-cli.md) usa `features/<FEAT-ID>.yaml` si existe;
mantiene `features/requests/` como alternativa para documentos históricos.

# Precisión de hallazgos (SA-101)

Reviewer requiere `evidence` concreta (hasta 4000 caracteres), `line` válida en el
SHA revisado y un fichero del diff para bloquear con blocker/major. El runtime
degrada los demás a minor, conserva `originalReport` y explica la degradación;
request_changes sin bloqueantes válidos pasa a approve efectivo. QA degrada
reproducciones genéricas o AC inexistentes; los AC sin verificar quedan not_tested.

`pixel-agents review finding <TASK> <index> --accept|--reject [--reason texto]`
registra una decisión humana inmutable sobre el último informe de verificación
persistido de la tarea (índice desde cero). No autoriza transiciones de la tarea.
`pixel-agents review precision [--feature FEAT-001] [--json]` muestra aceptación
por rol, executor, modelo y severidad, con n y motivos de degradación de los
hallazgos evaluados por humanos. Los informes históricos sin decisión no cuentan.

## Contexto entre Developer, Reviewer y QA (SA-099)

`developerRequest` reconstruye la FeatureSpec aprobada, sus SHA y los del diseño,
el diseño completo, la declaración de tarea y su alcance. Incluye, cuando existen,
findings de revisión, defectos de QA, historial de diseño y motivos de reintento o
fallo anterior. Para Reviewer/QA añade cobertura diferida del DAG.
`reviewerRequest` reutiliza esos datos y añade `reviewRef` (rama, base y SHA),
worktree, executor del Developer, lista de archivos, tests cambiados y diff Git
completo acotado a 1 MiB. `reviewerBrief` añade contrato, descubrimiento de tests
y errores de validación. `qaBrief` añade contrato, resultados de comandos del
runtime (incluida evidencia de baseline cuando está disponible), allowlist de
comandos adicionales y errores de validación. No se transfieren transcripts ni
la conversación del Developer; el receptor reconstruye el contexto desde
artefactos y evidencia persistida. Este handoff no se modifica en SA-099.

El compilador mantiene constitución, declaración de rol y reglas en un prefijo
estable con versión `PROMPT_RULES_VERSION`. Task, Brain, repositorio, modo doc y
schema de salida viajan después como JSON de contexto. Una huella del AgentSpec
canónico vincula todos sus campos sin duplicar la declaración completa.
`prefixHash` es SHA-256
de los bytes estables escritos por el runtime; en Codex incluye el delimitador
fijo anterior al contexto. Los dos executors tienen reglas distintas y por eso
pueden producir dos hashes para un rol. No mide los prompts internos del CLI,
herramientas o contexto que añada el proveedor.

El ledger conserva `prefixHash` y `role` como campos opcionales de su cuerpo JSON;
no necesita migración SQLite ni reescritura de registros históricos. Los registros
sin hash siguen siendo desconocidos, incluso si contienen `system_prompt_hash`
antiguo (en Codex incluía datos de tarea). `pixel-agents usage --json` expone
`byRole`, `distinctPrefixHashes` y `unknownPrefixExecutions`; la salida de texto
muestra los mismos indicadores por rol. `--feature FEAT-001` limita también esos
grupos. El hit rate pondera tokens de ejecuciones con ambos contadores conocidos.

Cada `start()` captura modelo, esfuerzo, AgentSpec, contexto y opciones del
executor antes del lanzamiento diferido. El registro reclama el ID de ejecución
en exclusiva antes de llamar al executor: reintentar/reanudar un CLI requiere un
nuevo ID registrado. El worker ya crea IDs nuevos para sus reintentos, corrección
de schema, lotes QA y cambios de selección. Cambiar opciones del llamador no
modifica el proceso capturado.

## Zonas y conflictos entre features

Antes de `develop`, el runner compara `changeZones` y `testZones` con las tareas
no DONE de otras runs no terminadas. El trabajo en ejecución conserva la propiedad;
entre trabajos pendientes gana la run creada antes (desempate por clave de feature).
Esto evita esperas circulares y aplica también al contrato `core/asyncapi.yaml`.
La comparación es conservadora: los prefijos literales incluyen descendientes.
La espera `zone conflict: <TASK> of <FEAT> overlaps <zona>` se guarda en la run,
aparece en la oficina y se reevalúa en la siguiente iteración, sin consumir intentos.
El orden secuencial dentro de una feature no cambia.

`pixel-agents zones check [--json]` compara cada rama local `sa/*` no integrada
con su merge-base de `main`. Informa ficheros compartidos y cambios fuera de las
zonas conocidas. No consulta remotos ni modifica ramas. La oficina inicia un monitor
asíncrono al consultar features (intervalo `ZONES_CHECK_INTERVAL_MS`), con gates
`zone_overlap`; `pixel-agents task show <KEY>` muestra la espera y avisos actuales.
Los avisos de ramas son informativos y no bloquean una integración.

## Aprendizajes por relevancia (SA-098)

Al persistir un informe de Reviewer/QA, el runtime deriva lecciones de sus
hallazgos sin llamar a modelos: título, regla de hasta 300 caracteres, zonas,
rol de implementación, tipo de tarea y origen (tarea, ejecución e índice).
Omite hallazgos degradados salvo aceptación humana SA-101 y omite los rechazados.
También propone los degradados al aceptarlos con `review finding`.
El contenido etiquetado como externo nunca genera propuestas.

`pixel-agents learning list` muestra propuestas, aprobadas y rechazadas en
`.softwareagents/brain/learnings/`. `learning approve <id>` mueve una propuesta
a `approved/`; `learning reject <id> [--reason <texto>]` la archiva en `rejected/`.
Los comandos exigen ingreso humano SA-003. Se rechaza lenguaje sobre permisos,
perfiles y políticas antes de proponer y al aprobar; las lecciones son datos.

El compilador selecciona como máximo cinco aprobadas: solape de zonas (4 puntos),
rol (2), tipo (1), desempate por ID. Omite puntuación cero y limita el JSON de
lecciones a 2400 caracteres, incluidos metadatos y escapes. Solo aparecen en
`learnings` del contexto no confiable; los paths de aprendizajes quedan excluidos
de la inyección genérica de Brain. Los prefijos y sus hashes permanecen estables.

## WIP y flujo (SA-096)

El operador configura `projects.<project-id>.wip` en `~/.pixel-agents/config.json`,
fuera del repositorio. Valores iniciales recomendados: `{"running": 2, "review": 3}`.
Cada campo ausente significa **sin límite** (compatibilidad con proyectos existentes);
los valores configurados deben ser enteros positivos. El runner relee los límites
en cada admisión. Running cuenta LEASED/RUNNING del proyecto, incluidas reservas
pendientes; review cuenta REVIEW/QA y tareas que esperan merge humano en una run
`ready_to_merge`, sin duplicarlas ni contar ramas ya integradas en main.
Al alcanzar el límite solo espera `develop`; review/QA tienen prioridad y avanzan.
La oficina muestra el motivo `WIP limit: review 3/3 (...)` y WIP actual/límite.

`pixel-agents flow [--feature FEAT-001] [--json]` lee una instantánea del WorkStore
sin migraciones ni escrituras. El filtro afecta métricas; WIP siempre es del proyecto.
Cycle time: primera entrada RUNNING hasta DONE; throughput: DONE por día UTC;
edad: última entrada real al estado WIP; espera de revisión: suma de intervalos
REVIEW/QA/WAITING_HUMAN, incluido el intervalo abierto. Duraciones en milisegundos;
mediana convencional, p85 por rango más próximo (`ceil(0.85*n)`), n de muestras
conocidas y tareas sin datos como desconocidas. El JSON incluye duraciones por tarea.
La oficina resume las distribuciones por feature y los límites del proyecto.

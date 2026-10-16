# Tasks: importación, listado, backup y restore (SA-027)

Desde la raíz del checkout de un Managed Project con
`.softwareagents/project.yaml`, Git y Node 22.13+ con `node:sqlite` disponible:

```text
pixel-agents task import ruta/relativa/dag.yaml
pixel-agents task list [--status WAITING_QUOTA] [--json]
pixel-agents task backup [--keep 7]
```

Los comandos usan la identidad del Project y el WorkStore compartido entre
worktrees (`<git-common-dir>/softwareagents/work.sqlite3`). No arrancan la oficina
ni Executors. La configuración inválida del Operator se rechaza; no se conceden
permisos desde el DAG. Los errores devuelven exit 1 y un diagnóstico sin stack.

## Migraciones de la base compartida

Abrir el WorkStore aplica sus migraciones automáticamente. Antes de abrir la base
con código nuevo, detener todos los procesos que la comparten (oficina, workers y
CLI) y actualizar **todos los procesos y worktrees** a una versión compatible.
Reiniciarlos solo después de la actualización; no mezclar escritores antiguos y
nuevos sobre la misma base. La migración v7 ya aplicada no se cambia ni reordena:
el código antiguo con INSERT posicional en `tasks` falla al encontrar `declaration`.
Todos los INSERT y UPDATE del WorkStore deben nombrar explícitamente sus columnas
para tolerar futuras columnas aditivas; esto no garantiza compatibilidad con otros
cambios de esquema ni sustituye la actualización coordinada.

## Importación y reimportación

El fichero debe ser un `TaskDAG` de SA-014. Se comprueban esquema, keys duplicadas
o ajenas, ciclos, dependencias y cobertura contra la FeatureSpec real en
`<brain.path>/features/<FEAT-###>.yaml` (pipeline SA-041/042) o, si ese archivo no
existe, `<brain.path>/features/requests/<FEAT-###>.yaml` (histórico). La validación
precede a la apertura de SQLite. Se reutilizan `parseTaskDag`,
`analyzeTaskDag` y el parser de FeatureSpec. Ambos YAML admiten como máximo 1 MiB,
rechazan claves duplicadas y acotan aliases. La ruta del DAG es relativa al
checkout, sin `..`, enlaces ni junctions; se contiene con `resolveInside`.
La misma protección se aplica a la FeatureSpec.

Cada importación crea la Feature si falta (ruta, HEAD y status como procedencia),
Tasks en DRAFT y sus dependencias en **una transacción**. La migración 7 conserva
la declaración completa en `tasks.declaration`, sin tablas nuevas. No actualiza
la procedencia de una Feature ya existente ni elimina Tasks omitidas en otro DAG.

**La primera declaración de cada key es inmutable.** Reimportar la misma key con
los mismos campos es un no-op, en cualquier estado, incluso con lease activa.
El orden de propiedades YAML, de `dependsOn` y de `acceptanceRefs` es irrelevante.
Cambiar título, descripción, tipo, rol, tamaño, referencias o dependencias rechaza
el lote entero, también si la Task sigue en DRAFT. Una key antigua sin declaración
persistida se rechaza: no se adopta ni se sobrescribe tácitamente. Las nuevas keys
pueden añadirse; las existentes mantienen estado, versión, intentos y lease.
Para cambiar una declaración hace falta otra key o un futuro flujo explícito de
reconciliación, revisado por humanos.

`AuditLog.append` registra `task_import/intent` antes de modificar Tasks y
`task_import/committed` después del commit, con input redactado y hasheado. Si el
primer append falla, no hay importación. SQLite y JSONL no comparten transacción:
un crash o fallo del segundo append puede dejar un intent sin committed aunque
las Tasks ya existan. El CLI falla visiblemente; reintentar es seguro por key.
Un intent tampoco prueba que el lote se haya confirmado.

## Listado

`--status` acepta los estados canónicos en mayúsculas. Sin opciones imprime key,
status, owner y expiración de lease, y razones de bloqueo. `--json` devuelve los
registros con `pendingDependencies`, `blockingReasons` y `resetsAt` (null si se
desconoce). WAITING_QUOTA conserva la razón y el reset persistidos por el worker;
WAITING_HUMAN muestra las decisiones abiertas o el motivo del último evento.
No sondea cuotas ni cambia estados para inferir disponibilidad.
El formato texto mantiene una fila por Task y escapa LF, CR, TAB y los controles
C0/C1 (incluido ESC) de sus campos. JSON conserva los valores originales.

## Backup

Imprime el directorio final:

```text
~/.pixel-agents/backups/<project>/<timestamp-UTC>-<uuid>/
  work.sqlite3
  audit.jsonl
  manifest.json
```

`VACUUM INTO` incluye los commits presentes en WAL y genera una base autónoma;
no se copia solamente el archivo principal abierto. `audit.jsonl` contiene el
JSONL del Project, vacío si aún no existe. Un lock exclusivo compatible con
AuditLog impide appends durante su copia. La base y el JSONL son dos snapshots
sucesivos, **no un único punto transaccional entre recursos**: para una copia
coordinada, detener los escritores antes del backup. El manifiesto incluye
Project, fecha, alcance y SHA-256 de ambos ficheros; los hashes detectan daños,
no autentican una copia frente a un atacante con acceso de escritura.

El snapshot SQLite contiene **todos los Projects del mismo Git common dir**;
el JSONL es solo del Project seleccionado. Una restauración revierte toda esa
base; si se comparte entre Projects, conservar también sus auditorías y coordinar
la parada de todos ellos.

Se escribe primero en `.pending-<uuid>`, se sincronizan los ficheros y se publica
por rename dentro del mismo directorio. La rotación ocurre después de publicar:
por defecto conserva 7 copias, `--keep` admite 1..1000. Un lock exclusivo por
Project serializa backups/rotación. Solo retira los tres ficheros conocidos de
directorios con nombre de copia; rechaza enlaces y contenido inesperado, sin
borrado recursivo. Un error de rotación puede dejar una copia nueva válida y más
de N copias; el comando devuelve error. No rota `.pending-*` de crashes anteriores.
Tras comprobar que no hay backup/escritor activo, el operador puede inspeccionar
y retirar un lock huérfano o un staging incompleto, sin seguir enlaces.

Las rutas de salida rechazan enlaces/junctions. Directorios nuevos usan modo
0700 y ficheros 0600; en Windows se heredan las ACL del perfil del usuario (los
modos POSIX no crean una ACL). El perfil debe ser privado. Como `pathGuard`, estas
guardas comprueban el filesystem actual: no confinan a otro proceso del mismo
usuario capaz de reemplazar directorios entre validación y uso. Un corte de
alimentación depende además de las garantías de rename/directorios del filesystem.

## Restore offline probado

No hay `task restore --yes`: los workers actuales no tienen un bloqueo global de
mantenimiento. Comprobar leases y luego reemplazar dos archivos dejaría una carrera
con un worker nuevo. La restauración es una operación de mantenimiento offline:

1. Detener oficina, autopilot, workers y CLI de **todos los worktrees/Projects que
   compartan la base** y evitar nuevos arranques. Confirmar que no quedan Executors
   supervisados. Una lease expirada no prueba que el proceso haya terminado; seguir
   la recuperación SA-026 de [worker-run.md](worker-run.md) ante cierre incierto.
   Para una recuperación directa, preferir una copia creada sin trabajo activo.
2. Seleccionar una copia completa, sin enlaces/junctions en su ruta ni en sus tres
   archivos. Verificar `format: 1`, `projectId` y ambos SHA-256 contra manifest.
   Abrir **la copia** con SQLite en readOnly y comprobar `PRAGMA integrity_check`
   (debe devolver `ok`), `PRAGMA foreign_key_check` (sin filas) y los Projects:

   ```powershell
   $snapshot = 'C:\ruta\a\la\copia'
   Get-Content -LiteralPath "$snapshot\manifest.json"
   Get-FileHash -LiteralPath "$snapshot\work.sqlite3", "$snapshot\audit.jsonl" -Algorithm SHA256
   node -e 'const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(process.argv[1],{readOnly:true}); console.log(d.prepare("PRAGMA integrity_check").all(),d.prepare("PRAGMA foreign_key_check").all(),d.prepare("SELECT project_id FROM projects").all()); d.close()' "$snapshot\work.sqlite3"
   ```

3. Obtener `git rev-parse --path-format=absolute --git-common-dir` desde el checkout;
   comprobar la ruta absoluta. Con todos los procesos parados, mover los archivos
   existentes `softwareagents/work.sqlite3`, `work.sqlite3-wal`, `work.sqlite3-shm`
   y `work.sqlite3-journal` que existan a un directorio de rollback privado fuera
   de esa ruta. No mezclar un WAL antiguo con la copia restaurada. Conservar también
   el JSONL actual `~/.pixel-agents/audit/<project>.jsonl` en rollback.
4. Copiar `work.sqlite3` a la ubicación vacía del WorkStore y `audit.jsonl` a la
   ubicación vacía del JSONL del Project, sin sobrescribir ni seguir enlaces.
   Aplicar permisos del usuario (0700/0600 en POSIX, ACL privada en Windows).
   Si cualquier paso falla, mantener la parada y devolver **ambos recursos y sus
   sidecars** desde rollback antes de arrancar nada. No restaurar un antiguo lock
   JSONL. No tocar `node_modules` ni otros directorios del Project.
5. Ejecutar `task list --json`, comprobar Tasks, dependencias y auditoría recuperada
   y reimportar el DAG: debe indicar `0 created`. Si el snapshot contiene leases
   o Executions sin cierre acreditado, revisar/recuperar por SA-026 antes de lanzar
   trabajo. Reanudar los procesos solo después de validar. Conservar rollback
   hasta concluir la revisión.

`server/__tests__/taskCli.test.ts` ejecuta el dispatcher real como subprocess con
HOME/USERPROFILE temporales: importa dos veces, conserva una lease, rechaza
entradas inválidas, respalda con WAL abierto, comprueba hashes/integridad y restaura
offline Tasks, dependencias, declaraciones y auditoría; también verifica rotación
y rechazo de junctions. La restauración nunca se prueba contra la base del operador.

Para QA real de Claude, construir `node esbuild.js`, preparar un Project desechable
con FeatureSpec y DAG válidos y ejecutar:

```text
node <worktree>/dist/cli.js task import dag.yaml
node <worktree>/dist/cli.js task import dag.yaml
node <worktree>/dist/cli.js task list --json
node <worktree>/dist/cli.js task list --status DRAFT
node <worktree>/dist/cli.js task backup --keep 2
```

Repetir backup tres veces, comprobar dos copias y seguir el restore offline en ese
Project desechable. Probar YAML inválido y comprobar exit 1 sin stack. Mantener
HOME y USERPROFILE aislados para esta QA.

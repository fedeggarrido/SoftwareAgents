---
Status: Proposed
Date: 2026-10-02
Owner: Fede
Related Feature: []
Supersedes: []
---

# ADR-0003: Estado operativo en SQLite local tras una interfaz WorkStore

## Status

**Proposed** · Fecha: 2026-10-02 · Tarea: SA-023 · Depende de: SA-001 / [ADR-0002](0002-evolucion-incremental-del-fork.md).

Decisor: **Fede**. Codex redacta y comprueba esta propuesta; Claude realizará la revisión cruzada e integración. La aceptación explícita de Fede está pendiente. Este ADR no implementa el WorkStore ni acredita pruebas de una implementación futura.

## Context

SoftwareAgents necesita recuperar Tasks, Executions, Leases y Human Decisions después de reiniciar procesos y coordinar servidor, workers y CLI en un mismo Host. El estado operativo legacy procede de scripts Python de Fundtrinsic y el fork proyecta fuentes como `board.json` y SQLite de claims/progreso mediante `boardWatcher.ts`. Fundtrinsic permanece fuera de alcance: no se modifican sus archivos, datos o procesos ni se exige migrarlos.

La arquitectura incremental de ADR-0002 conserva TypeScript, Fastify, AsyncAPI y los adaptadores existentes. `package.json` declara `engines.node >=20` y `engines.vscode ^1.105.0`; el job `npm-package-node20` comprueba el paquete instalado en Node 20. Una dependencia SQLite obligatoria al importar el runtime rompería esa compatibilidad.

Según la [documentación de Node](https://nodejs.org/api/sqlite.html), `node:sqlite` apareció en 22.5.0 y dejó de requerir `--experimental-sqlite` en 22.13.0 (también en 23.4.0). Ausencia de flag no significa API estable; el runtime local aún emite un aviso experimental. Para usar WorkStore sin flags se requiere Node 22.13+ con el módulo disponible; Node 20 sigue siendo válido para las funcionalidades existentes.

Se usa el [glosario SoftwareAgents](../../CONTEXT.md#softwareagents): Agent es una instancia persistente de AgentSpec; Session y Character son representaciones de ejecución y oficina. WorkStore designa aquí la interfaz de persistencia del estado operativo de un Project, no el `AgentStateStore` visual legacy.

## Constraints

Conservar compatibilidad con Node 20 para funciones existentes, las capas actuales y Fundtrinsic fuera de alcance. La apertura de WorkStore requiere soporte explícito del runtime y autorización externa al Project Brain.

## Options considered

| Opción                                           | Ventajas                                                                                  | Costes y límites                                                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`node:sqlite` con carga perezosa (propuesta)** | SQLite incluido en Node; transacciones y consultas sin añadir un addon a la distribución. | Disponible según versión/build de Node; API con estabilidad dependiente del runtime; `DatabaseSync` bloquea el hilo donde se invoca.                                                                |
| **`better-sqlite3`**                             | API SQLite consolidada y soporte para versiones de Node anteriores al módulo integrado.   | Addon nativo: binarios por plataforma/arquitectura y compatibilidad ABI, posibles builds/rebuilds y más complejidad al empaquetar `.vsix` y npm. También ofrece una API síncrona.                   |
| **Ficheros JSON**                                | Sin dependencia DB, legibles y adecuados para configuración pequeña.                      | Rename atómico de un fichero no resuelve actualizaciones concurrentes, transacciones entre entidades, leases ni consultas. Habría que construir locks, recuperación y control de versiones propios. |

El [proyecto better-sqlite3](https://github.com/WiseLibs/better-sqlite3) documenta su instalación nativa y disponibilidad de binarios precompilados; estos reducen trabajo de instalación, pero no eliminan la matriz de distribución ni los casos que requieren compilación.

## Decision

### Límite WorkStore y activación

1. Definir una interfaz **WorkStore** de operaciones de dominio y transacciones necesarias para el slice; los consumidores no reciben conexiones SQL ni dependen del driver. El contrato compartido puede vivir en `core/` sin efectos de runtime, y la implementación SQLite en `server/`, respetando las capas actuales. No introducir un ORM, repositorio genérico ni motor de workflows.
2. Abrir el WorkStore únicamente cuando un Managed Project lo use explícitamente, desde la composición **standalone**. Workers y CLI del mismo Host usan la misma implementación del lado servidor al realizar operaciones de WorkStore. La extensión VS Code no abre esta base en su Extension Host; una futura integración se comunica con standalone mediante el contrato correspondiente, sin implementar ese transporte aquí.
3. Cargar `node:sqlite` dentro de la fábrica de apertura, nunca mediante un import de valor o require ejecutado al cargar módulos compartidos, activar VS Code o arrancar una oficina sin WorkStore. Mantener el builtin externo en los bundles. Comprobar disponibilidad y API requerida en esa frontera, incluso si la versión parece suficiente.
4. Si se solicita WorkStore y falta soporte, rechazar la apertura con un error accionable que incluya versión actual y causa: «WorkStore requiere Node 22.13+ con node:sqlite disponible; ejecuta el servidor standalone con un Node compatible». No continuar con persistencia en memoria, JSON ni éxito aparente. Una base corrupta o un fallo de permisos se informa como tal, sin confundirlo con falta del módulo.
5. **No cambiar `engines`, dependencias, CI ni comportamiento legacy** en SA-023. No convertir la tolerancia actual de `boardWatcher.ts` ante SQLite legacy ausente en la política de errores del nuevo WorkStore.

### Ubicación e identidad

La base será **`<git-common-dir>/softwareagents/work.sqlite3`**, compartida entre worktrees y fuera del árbol versionado. Obtener el directorio mediante Git, por ejemplo `git rev-parse --path-format=absolute --git-common-dir`, ejecutado en el repositorio del Project; no asumir que `.git` sea un directorio ni usar el git-dir privado de un worktree.

Canonicalizar el common dir y resolver la ruta bajo esa raíz mediante la guardia `resolveInside` con realpath, incluyendo padres existentes cuando aún no exista el fichero, para contener symlinks/junctions. Crear el directorio solo al activar WorkStore; fallar explícitamente si Git o la ruta autorizada no están disponibles. No aceptar una ruta DB arbitraria desde contenido del Project Brain como autoridad. La identidad Project y los identificadores de Task/Execution deben ser estables entre ramas y worktrees; el esquema concreto se diseña en la implementación.

No se versionan la base ni sus auxiliares `-wal`/`-shm`. Clonar el repositorio no copia su estado operativo; borrar el common dir lo pierde. Backup y recuperación deberán usar un procedimiento consistente con SQLite, no copiar solo el fichero principal mientras haya escritores activos.

### Concurrencia y recuperación

Servidor, workers y CLI pueden abrir conexiones separadas al mismo fichero **en un único Host y filesystem local**. Usar `PRAGMA journal_mode=WAL` y comprobar el modo obtenido; configurar `PRAGMA busy_timeout = 5000` en cada conexión como valor inicial revisable por medición. No depender de la opción `timeout` del constructor, añadida después del mínimo Node 22.13.

[WAL](https://sqlite.org/wal.html) permite lectores junto a un escritor, pero serializa escritores y necesita coordinación local; no es una solución para varios Hosts o un filesystem de red. [`busy_timeout`](https://sqlite.org/pragma.html#pragma_busy_timeout) acota la espera por locks y puede terminar en `SQLITE_BUSY`. No promete que toda escritura tenga éxito.

Mantener transacciones cortas: ninguna ejecución CLI, llamada de red o espera humana dentro de una transacción. Adquisición/renovación de Lease y transiciones relacionadas deben ser atómicas y condicionales al propietario y versión vigentes. Una Lease expirada no prueba que el proceso previo haya terminado; rechazar escrituras de propietarios obsoletos. Reintentos acotados requieren operaciones idempotentes; no repetir a ciegas efectos externos. Persistir el cambio y su DomainEvent/Audit log relacionado en la misma transacción cuando proceda, y publicar proyecciones tras commit.

`DatabaseSync` y la espera por locks pueden bloquear el event loop. La implementación deberá aislar operaciones potencialmente bloqueantes del hilo HTTP/WS cuando sea necesario y medir latencia, duración de transacciones, frecuencia de busy y reintentos. Coordinar migraciones versionadas entre procesos, cierre y checkpoints; estos detalles y sus pruebas pertenecen a tareas de implementación.

### Fuentes de verdad

| Fuente                  | Autoridad                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Git / Project Brain** | Declarativa: AgentSpecs, FeatureSpecs, TechnicalDesigns, ADRs y políticas revisadas; registrar la revisión usada por una Execution.                                  |
| **WorkStore**           | Operativa: instancias Agent, estado de Tasks/Executions, Leases, Human Decisions, resultados de Gates, DomainEvents y Audit log.                                     |
| **ClickUp**             | Espejo del trabajo operativo de la Platform; **durante la transición sigue siendo el backlog humano** del Development Project, donde Fede prioriza y define trabajo. |

La transición requiere importación/reconciliación explícita de cambios humanos y referencias estables a tareas externas. ClickUp no puede sobrescribir una Lease o Execution activa ni conceder permisos por un cambio de estado. Un fallo de sincronización se muestra y se reintenta sin deshacer commits del WorkStore. Operator config sigue siendo la autoridad de comandos y límites del Host; persistir una decisión no sustituye su validación por política. Pixel Office y Command Center proyectan el estado; no lo inventan.

## Evidencia local y validación pendiente

Inspección del 2026-10-02, sin abrir bases de proyectos ni modificar el perfil del operador:

| Runtime                                               | Resultado observado                                                                                                                                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --version`                                      | **v24.14.1**. `require('node:sqlite')` exporta `DatabaseSync`, `StatementSync`, `Session`, `constants`, `backup`; una consulta en `:memory:` devuelve SQLite **3.51.2**, con `ExperimentalWarning`. |
| `code --version`                                      | VS Code **1.136.1**, commit `a44adf7f53e00964ab890f9f8758a334f1fc15bc`, x64. Este comando no informa de Node/Electron.                                                                              |
| Binario local `Code.exe` con `ELECTRON_RUN_AS_NODE=1` | `process.versions` confirma **Electron 42.10.0**, **Node 24.18.1**, SQLite **3.53.1**; importar el módulo, abrir `:memory:` y consultar su versión funciona.                                        |

Instalación inspeccionada: `C:\Users\fedeg\AppData\Local\Programs\Microsoft VS Code`. Para reproducir en PowerShell (la variable se restaura al acabar y solo se usa para lanzar el proceso de comprobación):

```powershell
$previousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE = '1'
try {
  & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" -e "console.log(JSON.stringify(process.versions)); const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(':memory:'); console.log(db.prepare('select sqlite_version() as version').get()); db.close();"
} finally {
  if ($null -eq $previousElectronRunAsNode) {
    Remove-Item Env:ELECTRON_RUN_AS_NODE
  } else {
    $env:ELECTRON_RUN_AS_NODE = $previousElectronRunAsNode
  }
}
```

El binario emitió además un aviso de acceso denegado de Crashpad en el sandbox; las consultas terminaron correctamente. Esta evidencia corresponde al Electron instalado en modo Node, no a una prueba de activación en Extension Host, ni demuestra soporte en el mínimo VS Code 1.105 o en instalaciones remotas/web. Por eso no condiciona la extensión a SQLite.

`npm-package-node20` permanece sin cambios: ejecuta `npm run test:package-contract && npm run verify:npm-package` bajo Node 20. Este ADR solo cambia documentación; no añade carga perezosa ejecutable. No se declara el job remoto verde a partir de una inspección o de pruebas en Node 24. La implementación deberá demostrar arranque del paquete sin WorkStore en Node 20, error claro al solicitarlo sin módulo y apertura/transacciones con Node compatible, además de concurrencia y recuperación en Windows. La aceptación de esa carga perezosa queda pendiente de esas pruebas.

## Why

SQLite aporta transacciones y recuperación local sin distribuir un addon nativo. La carga perezosa y la interfaz WorkStore mantienen la compatibilidad legacy y acotan la dependencia del driver, según la evidencia y límites registrados arriba.

## Consequences

- SQLite aporta atomicidad y recuperación local sin desplegar un servicio DB ni distribuir un addon nuevo. La interfaz permite revisar el backend sin propagar SQL al dominio.
- WorkStore tiene un requisito de runtime superior al mínimo del paquete; debe quedar visible en la activación y documentación del standalone.
- Compartir estado entre worktrees permite coordinar tareas, pero los permisos del filesystem y Operator config siguen siendo necesarios; el fichero no es una frontera multiusuario.
- Hacen falta migraciones, backup, pruebas de fallos y disciplina transaccional. No se implementan aquí esquema, interfaz, driver, sincronización ClickUp ni migración legacy.

## Revisit when

Revisar con un nuevo ADR aprobado por Fede cuando haya **más de un Host**, operación **multiusuario** con aislamiento/autorización no cubierta por el modelo local, o **contención de escritura medida** (busy recurrente, latencia o reintentos que incumplan los objetivos del slice). Evaluar entonces Postgres u otra alternativa con evidencia, sin migración automática.

También revisar si las APIs/versiones soportadas de Node dejan de satisfacer distribución o recuperación, o si el bloqueo síncrono persiste tras acortar/aislar operaciones. WAL y un timeout mayor no sustituyen esa evaluación.

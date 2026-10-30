# SA-030: Backlog y dock desde WorkStore

En un Project con WorkStore registrado, Backlog y el dock usan un snapshot de
lectura de Tasks, dependencias, leases, executions y domain events. Se refresca
cada tres segundos, incluso para importaciones sin eventos. SQLite se abre con
`readOnly: true` en un worker, sin migraciones, sweeper ni espera de locks en el
event loop. Una transacción mantiene coherentes las filas del snapshot.

- Fase: `Task.status`, sin traducir estados en el protocolo.
- Owner: titular de la lease; sin lease, rol de la última ejecución registrada,
  rol de la Task o key de ejecución. Una ejecución de una lease anterior no se
  atribuye a una nueva lease. La caducidad solo se muestra: nunca se recupera.
- Último evento: domain event con mayor id de esa Task. Se muestra la transición;
  reasons y actores no se envían. Actividad reciente conserva los eventos recientes.
- Identidad y título: key de la Task. No se envían declaraciones ni prompts.
  Las pills resuelven esa key por asociación de sesión o por el detalle de rol.
- Documentos: se excluyen siempre las keys `FEAT-n`, `FEAT-n-DESIGN` y
  `FEAT-n-REQUIREMENTS`, también en REVIEW tras merge. Su seguimiento corresponde
  al panel de features. Las tareas del DAG, incluidas tareas `doc` con key de
  trabajo, y las importadas con `task import` sí aparecen, aunque estén en DRAFT.
- Sin fichero o sin registro del Project en `projects`, se conserva la ruta legacy.
  Un Project sin manifiesto sigue siendo legacy aunque exista SQLite. Un fichero
  existente ilegible muestra indisponibilidad y se reintenta, sin mostrar claims
  antiguos. Un WorkStore registrado vacío es un backlog vacío, no un fallback.

El campo opcional `boardState.sources.workStore` identifica esta fuente.
`sources.board` indica si el snapshot es legible; `claims` y `progress` siguen
describiendo exclusivamente las fuentes legacy. `workSnapshot` no cambia.

## Smoke standalone con un fixture aislado (PowerShell)

Requiere Node con `node:sqlite`, dependencias ya disponibles y el build standalone
actual (`dist/cli.js` y webview). Claude realiza esta comprobación visual antes de
integrar. No usa un WorkStore real, cuentas, red externa ni CLIs de IA.

Desde el worktree, crea un repositorio de prueba nuevo (no reutilices una ruta con
datos). El siguiente bloque solo escribe el fixture:

```powershell
$source = $PWD.Path
$fixture = Join-Path $source '.vitest-tmp/sa030-smoke'
if (Test-Path $fixture) { throw 'Elige otra ruta de fixture vacía' }
New-Item -ItemType Directory $fixture | Out-Null
git init $fixture
$env:SA_BOARD_SMOKE_ROOT = $fixture
@'
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { runMigrations } = require('./server/src/workstore/migrations.ts');
const root = process.env.SA_BOARD_SMOKE_ROOT;
fs.mkdirSync(path.join(root, '.softwareagents/brain'), { recursive: true });
fs.writeFileSync(path.join(root, '.softwareagents/project.yaml'), JSON.stringify({
  apiVersion: 'softwareagents.io/v1alpha1', kind: 'Project', id: 'board-fixture',
  name: 'Board fixture', repo: { remote: 'https://example.invalid/fixture.git', defaultBranch: 'main' },
  brain: { path: '.softwareagents/brain' }
}));
fs.mkdirSync(path.join(root, '.git/softwareagents'), { recursive: true });
const db = new DatabaseSync(path.join(root, '.git/softwareagents/work.sqlite3'));
runMigrations(db); // Solo preparación del fixture; nunca la hace el lector.
const now = new Date().toISOString();
db.prepare('INSERT INTO projects VALUES (?, ?)').run('board-fixture', now);
const task = db.prepare(`INSERT INTO tasks
  (project_id, key, type, status, priority, agent_role, version, attempt, max_attempts,
   lease_owner, lease_expires_at, created_at, updated_at)
  VALUES ('board-fixture', ?, 'code', ?, 0, 'developer', 1, 0, 3, ?, ?, ?, ?)`);
for (const [key, status] of [['FEAT-001-T01', 'RUNNING'], ['FEAT-001-T02', 'DRAFT'],
  ['FEAT-001-T03', 'DONE'], ['FEAT-001-DESIGN', 'REVIEW']]) {
  task.run(key, status, status === 'RUNNING' ? 'fixture-worker' : null,
    status === 'RUNNING' ? new Date(Date.now() + 3600000).toISOString() : null, now, now);
}
db.prepare(`INSERT INTO domain_events
  (project_id, task_key, type, from_status, to_status, task_version, attempt, reason, actor, created_at)
  VALUES ('board-fixture', 'FEAT-001-T01', 'TASK_TRANSITIONED', 'LEASED', 'RUNNING', 1, 0, '', 'fixture', ?)`)
  .run(now);
db.close();
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, '.pixel-agents'), { recursive: true });
fs.writeFileSync(path.join(home, '.pixel-agents/config.json'), JSON.stringify({
  projects: { 'board-fixture': { autonomyLevel: 'A0', allowedExecutors: [] } }
}));
'@ | node --require tsx/cjs
```

Arranca la oficina con el perfil del fixture:

```powershell
$env:HOME = Join-Path $fixture 'home'
$env:USERPROFILE = $env:HOME
$env:CLAUDE_CONFIG_DIR = Join-Path $env:HOME '.claude'
$env:CODEX_HOME = Join-Path $env:HOME '.codex'
Set-Location $fixture
node (Join-Path $source 'dist/cli.js') --host 127.0.0.1 --port 8787
```

Abre la URL local que imprime el proceso. No habilites executors ni hooks.
En **Tareas**, comprueba la indicación «WorkStore · solo lectura», T01 en RUNNING
con owner `fixture-worker` y evento LEASED → RUNNING, T02 en DRAFT, y T03 visible
al activar **Hechas**. DESIGN no aparece. El dock cuenta tres tareas, una hecha y
una en curso. En el WebSocket, `boardState.items[].id` contiene las keys anteriores.
Sin sesiones el fixture no crea personajes; para comprobar las pills en la QA real,
una sesión asociada a T01 debe mostrar `rol · FEAT-001-T01`.

Detén con Ctrl+C y vuelve al worktree. Conserva `.vitest-tmp/`; no copies este
SQLite a `.git/softwareagents` del proyecto real. Las variables de perfil deben
restaurarse o cerrarse junto con esta consola de smoke.

La suite `server/__tests__/workStoreBoardSource.test.ts` ejecuta además el verdadero
handler `task import` sobre fixtures, sin commits ni red, y comprueba refresco,
leases caducadas sin escritura, exclusión documental y fallback legacy.

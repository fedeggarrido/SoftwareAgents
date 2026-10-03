# Selección y quota gate (SA-036)

`pixel-agents quota check --executor claude|codex --role <rol> [--json]`
devuelve 0 para `go` o `probe`, y 3 para `wait`. JSON incluye `reason` y,
en espera por cuota, `resetsAt` (epoch seconds; null si no se conoce).
El rol es informativo: no reserva porcentajes ni concede permisos.

`worker run --task SA-### --brief <archivo> --select-executor` activa la selección
por capabilityClass del Developer. Sin ese flag se conserva el worker Claude.
La primera preferencia permitida se mantiene incluso si debe esperar; no hay
fallback. El modelo opcional se pasa al Executor, nunca se fija en el servidor.

`.softwareagents/agents/model-policy.yaml` es un catálogo ordenado de preferencias
declarativas. Su parser rechaza campos de autoridad. La ruta permanece protegida
por SA-063. Solo `~/.pixel-agents/config.json → projects.<id>` autoriza executors,
`quotaThresholds` (porcentaje mínimo restante) y `concurrency.perExecutor`.
El tope efectivo es el mínimo entre todos los proyectos que permiten ese executor;
si alguno carece de tope explícito, el gate espera. No se modifica esa config.

El consumidor necesita una observación global del operador en
`~/.pixel-agents/machine-capacity.json`, con esta forma:

```json
{
  "observedAt": 1791000000,
  "active": { "claude": 0, "codex": 1 },
  "capacities": {}
}
```

`active` debe incluir toda la máquina, también otros proyectos y lanzamientos
externos. Nunca se supone cero si falta. La observación caduca a los 60 segundos;
ausencia, datos inválidos o fecha futura producen espera. `capacities` contiene
opcionalmente CapacitySnapshots de SA-035 por executor. Sin cuota conocida y con
recuento válido, se permite una única sonda. Ventanas ya reseteadas se descartan;
las demás ventanas siguen bloqueando si su cuota está bajo el umbral.

**Publicación (SA-QA-3).** El servidor standalone de la oficina (`pixel-agents`) publica esta
observación cada 15 s de forma atómica mientras está en marcha (`MachineCapacityPublisher`):
`active` cuenta **todas** las sesiones que la oficina sigue por executor, activas o en espera
(contar de más solo hace esperar; contar de menos permitiría superar el tope), y `capacities`
copia los CapacitySnapshots de SA-035. Alcance: solo lo que ve esa oficina; las sesiones de
otros workspaces cuentan únicamente con Watch All Sessions activado. Si la oficina se para, la
observación caduca a los 60 s y el gate vuelve a esperar. No inspecciona procesos ni datos de
Fundtrinsic.

**Configuración del operador necesaria** (en `~/.pixel-agents/config.json → projects.<id>`;
la escribe el operador, nunca el repo). Sin `concurrency.perExecutor` el gate espera siempre:

```json
{
  "projects": {
    "softwareagents": {
      "autonomyLevel": "A1",
      "allowedExecutors": ["claude", "codex"],
      "concurrency": { "maxExecutions": 1, "perExecutor": { "claude": 1, "codex": 1 } },
      "quotaThresholds": { "claude": 10, "codex": 10 }
    }
  }
}
```

`quotaThresholds` es el porcentaje mínimo restante por executor; un valor conservador evita
agotar la cuota compartida con otros proyectos. Es un gate observacional,
no una reserva atómica: dos consumidores pueden leer el mismo recuento antes de
lanzar. No habilitar paralelismo desatendido hasta el ledger/reservas de SA-037.

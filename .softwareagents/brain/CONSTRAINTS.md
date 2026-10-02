# Restricciones

## Ejecución local supervisada

- LLMs solo mediante Claude Code y Codex locales, autenticados con suscripción del Operator. Sin API keys de modelos ni gateway API en el MVP; esto no excluye credenciales necesarias para GitHub o ClickUp, siempre externas al brain.
- Windows es entorno obligatorio de validación, incluida cancelación de árboles de procesos y rutas con junctions. Un worktree por Task separa cambios Git, pero no confina filesystem, red, recursos ni herramientas heredadas del usuario.
- El MVP no incorpora sandbox de SO; Claude en Windows accede con los permisos efectivos del usuario. Docker queda en Later. Esto no pide desactivar el sandbox que un entorno de desarrollo ya proporcione. Consultar el [threat model](../../docs/security/threat-model.md) antes de ampliar autonomía o ejecutar contenido no confiable.
- Fundtrinsic queda fuera: no leer ni modificar sus archivos, datos o procesos, ni exigir su migración. La cuota compartida se observa sin intervenir en ese proyecto.
- La autoridad está en Operator config y controles deterministas externos al LLM. A1 y las declaraciones del brain no acreditan aislamiento ni implementación del motor de políticas. Merge mediante el Gate humano de [AGENTS.md](../../AGENTS.md).

## Versiones y compatibilidad

Baseline local de SA-012 (2026-10-02); las versiones observadas no elevan automáticamente los mínimos de distribución:

| Componente          | Mínimo / baseline                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------- |
| Node del paquete    | `engines.node >=20`, preservado para funcionalidades existentes                              |
| Node local          | 24.14.1, observada en SA-023                                                                 |
| VS Code del paquete | `engines.vscode ^1.105.0`                                                                    |
| VS Code local       | 1.136.1 / Electron 42.10.0 (Node 24.18.1), observada en SA-023                               |
| Codex CLI           | 0.159.x, baseline mínima del dogfooding; validar el contrato del Executor antes de cambiarla |
| Claude Code CLI     | 2.1.161, baseline mínima del dogfooding, observada con `claude --version` en este worktree   |

No se afirma compatibilidad de Executors con versiones inferiores a esas baselines de CLI. El WorkStore futuro de ADR-0003 requiere Node 22.13+ con `node:sqlite` disponible sin flags; no cambia el mínimo Node 20 del producto legacy ni acredita implementación actual.

## Bootstrap y validación

SA-032 midió el fixture de bootstrap de worktree: **935 ms en frío y 70 ms con caché**. La medición con dependencias reales sigue pendiente; estos números no son un SLA ni una medida del repositorio completo.

Los `node_modules` de los worktrees son junctions al repo principal: no instalar dependencias, escribir en ellas ni borrarlas recursivamente. Aplicar AGENTS.md, guardar sin BOM y ejecutar Prettier, ESLint cuando aplique, `npm run check-types` y pruebas pertinentes. En tests usar TEMP/TMP dentro del worktree y limpiar al terminar; aislar `os.homedir()` para no escribir en `~/.pixel-agents` o `~/.claude` reales.

Conservar Fastify, AsyncAPI, React/Vite, canvas y las capas existentes. No mover ADRs ni duplicar CLAUDE.md/CONTEXT.md. Secretos, transcripts, estado operativo mutable y config del Operator no se versionan en el brain.

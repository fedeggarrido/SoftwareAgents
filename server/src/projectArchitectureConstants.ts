import * as policy from '../../eslint-rules/hexagonal-policy.json';

export const HEXAGONAL_MARKER = policy.marker;
export const HEXAGONAL_CONFIG = policy.config;
export const ARCHITECTURE_DECISION_PREFIX = 'project-architecture/';
export const ARCHITECTURE_PROPOSAL_ERROR = 'architecture-proposal:';
export const HEXAGONAL_RULE_ID = 'pixel-agents/hexagonal-boundaries';
export const HEXAGONAL_TEMPLATE = [
  'Arquitectura hexagonal por defecto: src/domain (dominio puro, sin paquetes ni node:),',
  'src/application (casos de uso y puertos; solo dominio y su propia capa),',
  'src/adapters/in (HTTP, CLI, UI), src/adapters/out (BD, APIs, colas),',
  'src/composition (única raíz de inyección de dependencias).',
  'Los adaptadores dependen de application/domain y de su propia capa; nunca entre entrada y salida.',
  'Cada tarea del DAG nombra la capa que toca en su título, también las tareas de pruebas y documentación.',
  'Declara architecture.kind=hexagonal. Para otra arquitectura, declara kind=alternative, name,',
  'rationale y alternatives (incluye hexagonal): el runtime reserva un ADR y solicita una decisión humana.',
  'El agente propone; nunca decide. No publiques diseño ni DAG antes de la respuesta humana.',
].join(' ');

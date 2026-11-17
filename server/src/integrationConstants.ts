export const INTEGRATION_CATALOG_FILE = 'integrations.yaml';
export const OUTBOUND_ADAPTER_ZONE = 'src/adapters/out/**';
export const INTEGRATION_DECISION_PREFIX = 'integration-access/';
export const INTEGRATION_SERVICE_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
export const IMPLEMENTATION_ROLES: readonly string[] = ['developer', 'integrations'];

export const INTEGRATION_TASK_RULES = [
  'Assign every code task whose changeZones overlap src/adapters/out/** to agentRole integrations. This conservative policy includes local outbound adapters.',
  'Declare externalServices as unique lowercase service ids (kebab-case). Every integrations task must declare at least one service and include the exact runtime integrationCatalogPath in changeZones. Other roles cannot declare externalServices.',
  'Read the integration catalog from context and declare the service ids affected by the task; never invent authorization.',
].join('\n');

export const INTEGRATION_PROMPT = [
  'Implement one client per external service behind an application port in src/application, implemented in src/adapters/out and wired in src/composition.',
  'Use timeouts, retries with backoff only for idempotent operations or requests with idempotency keys, rate limits, a circuit breaker and pagination.',
  'Use typed errors mapped to domain errors and logs without secrets. Credentials come only through project config or a secret manager, never in code, logs or prompts.',
  'Generate typed contracts from OpenAPI when available. Provide contract tests plus fakes and use the provider sandbox when available within human-authorized access.',
  'Detect duplicated or inconsistent calls to the same service and propose unifying them behind its port and client.',
  'Update integrationCatalogPath with service, port, auth method, limits and owner for every declared externalServices entry. Store metadata only, never credentials.',
  'New external access is a HUMAN decision enforced before execution. Never decide or answer that decision, create accounts or create real keys. Escalate additional services outside the declared scope.',
].join('\n');

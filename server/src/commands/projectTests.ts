import { CliUsageError } from '../cliErrors.js';
import { detectTestProfile, type ProjectKind, type TestLayer } from '../projectTestProfile.js';

const KIND: Record<ProjectKind, string> = {
  web: 'aplicación web',
  api: 'API',
  cli: 'herramienta de línea de comandos',
  library: 'librería',
};
const LAYER: Record<TestLayer, string> = {
  unit: 'unitarios',
  e2e: 'e2e en navegador real con capturas',
  design: 'barrido de diseño y accesibilidad',
  contract: 'de contrato de la interfaz pública',
};

/** SA-163: read-only view of the tests SoftwareAgents will ask for in this project. */
export function runProjectTests(argv: string[]): void {
  if (argv.length !== 1) throw new CliUsageError('pixel-agents project tests');
  const profile = detectTestProfile(process.cwd());
  if (!profile) {
    console.log('No se reconoce el stack del proyecto: los agentes no reciben una guía de tests.');
    return;
  }
  console.log(`Proyecto: ${KIND[profile.kind]}.`);
  console.log(`Tests que se exigen por cada criterio: ${profile.layers.map((l) => LAYER[l]).join(', ')}.`);
  console.log(`Herramientas: ${[profile.unit, profile.e2e].filter(Boolean).join(', ')}.`);
  console.log(
    profile.missing.length
      ? `Falta instalar, con tu aprobación: ${profile.missing.join(', ')}. Los agentes no la instalan.`
      : 'No hace falta instalar nada nuevo.',
  );
}

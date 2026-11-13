import type {
  StackAlternative,
  StackClaim,
  StackProposal,
} from '../../../core/src/projectStack.js';
import { makeSource } from '../../src/research.js';

export const stackSource = () =>
  makeSource({
    adapter: 'fixture',
    kind: 'web',
    language: 'en',
    title: 'Documentación oficial de prueba',
    url: 'https://example.com/stack',
    excerpt:
      'TypeScript Node PostgreSQL Docker Vitest GitHub Actions. Python Django SQLite pytest. Java Spring JUnit Jenkins. Stable support. Version 5. Cost 7 EUR. Ports and adapters.',
  });

export function stackProposal(count = 2): StackProposal {
  const source = stackSource();
  const claim = (text: string): StackClaim => ({
    text,
    sources: [source.id],
    quotes: [{ sourceId: source.id, text: source.excerpt }],
  });
  const products = {
    typescript: {
      language: 'TypeScript',
      framework: 'Node',
      data: 'PostgreSQL',
      testing: 'Vitest',
      ci: 'GitHub Actions',
    },
    python: {
      language: 'Python',
      framework: 'Django',
      data: 'SQLite',
      testing: 'pytest',
      ci: 'GitHub Actions',
    },
    java: {
      language: 'Java',
      framework: 'Spring',
      data: 'PostgreSQL',
      testing: 'JUnit',
      ci: 'Jenkins',
    },
  };
  const alternatives: StackAlternative[] = Object.entries(products)
    .slice(0, count)
    .map(([id, product]) => ({
      id,
      name: `Stack ${product.language}`,
      stack: {
        language: claim(product.language),
        framework: claim(product.framework),
        data: claim(product.data),
        hosting: claim('Docker'),
        testing: claim(product.testing),
        ci: claim(product.ci),
      },
      comparison: {
        fit: claim('Inferencia · Encaja con los requisitos de despliegue local.'),
        maturity: claim('Stable support'),
        cost: claim('7 EUR'),
        learningCurve: claim('Inferencia · Requiere aprendizaje del equipo.'),
        risks: claim('Inferencia · Revisar la experiencia del equipo.'),
        ecosystem: claim('Stable support'),
      },
      hexagonal: claim('Inferencia · Dominio independiente con puertos y adaptadores.'),
    }));
  return {
    alternatives,
    recommendation: 'typescript',
    why: claim('Inferencia · Encaja con los requisitos de despliegue local.'),
    losses: alternatives.slice(1).map((alternative) => ({
      alternative: alternative.id,
      detail: claim('Inferencia · Se pierde la integración del framework alternativo.'),
    })),
  };
}

import * as fs from 'node:fs';
import * as path from 'node:path';

import { taskDirectory, taskPath } from './commands/taskFiles.js';
import { optionalEntry } from './newProjectPaths.js';
import {
  HEXAGONAL_CONFIG,
  HEXAGONAL_MARKER,
  HEXAGONAL_TEMPLATE,
} from './projectArchitectureConstants.js';

/** Stack language is a human-authored claim, not a closed catalog in SA-156. */
export function architectureTemplateLanguage(language: string): 'ts' | 'js' | 'layout' {
  const languages = [
    { pattern: /\btypescript\b/i, extension: 'ts' as const },
    { pattern: /\bjavascript\b|\bnode\.?js\b/i, extension: 'js' as const },
  ];
  return languages.find(({ pattern }) => pattern.test(language))?.extension ?? 'layout';
}

export function hexagonalTemplate(language: string): Map<string, string> {
  const extension = architectureTemplateLanguage(language);
  const files = new Map<string, string>();
  files.set(
    'src/README.md',
    `# Arquitectura del proyecto\n\n${HEXAGONAL_TEMPLATE}\n\nLenguaje elegido: ${language.replace(/[\r\n]/g, ' ')}.\n\n` +
      'El dominio no usa paquetes externos ni módulos de Node, incluidos los de apariencia pura. ' +
      'Los efectos se expresan mediante puertos de application. domainAllowlist permite excepciones explícitas por especificador.\n\n' +
      'El marcador .softwareagents/hexagonal.json activa el verificador. layers usa globs relativos con *, ** y ?; ' +
      'aliases relaciona prefijos terminados en / con carpetas relativas (por ejemplo, "@domain/": "src/domain"). ' +
      'Declara ahí los alias de tu compilador. Los destinos locales sin capa y los imports no literales se rechazan. ' +
      'Las pruebas fuera de src quedan fuera del grafo de producción.\n\n' +
      (extension === 'layout'
        ? 'Este stack recibe la estructura y esta guía; implementa el ejemplo y un verificador de imports propio de su lenguaje antes de desarrollar. ESLint verifica únicamente JavaScript y TypeScript.\n'
        : extension === 'js'
          ? 'Ejemplo: node --experimental-default-type=module src/composition/main.js\n'
          : 'Ejemplo: compila src/composition/main.ts con TypeScript (target ES2022, module NodeNext) y ejecuta el JavaScript resultante. No requiere paquetes de aplicación.\n'),
  );
  for (const [layer, globs] of Object.entries(HEXAGONAL_CONFIG.layers)) {
    const directory = globs[0].replace('/**', '');
    files.set(`${directory}/README.md`, `# ${layer}\n\n${HEXAGONAL_TEMPLATE}\n`);
  }
  if (extension !== 'layout') {
    const typed = extension === 'ts';
    files.set(
      `src/domain/greeting.${extension}`,
      `export function greeting(name${typed ? ': string' : ''})${typed ? ': string' : ''} {\n  return \`Hola, \${name.trim()}\`;\n}\n`,
    );
    files.set(
      `src/application/greet.${extension}`,
      `import { greeting } from '../domain/greeting.js';\n\n` +
        (typed ? 'export interface GreetingLog {\n  save(message: string): void;\n}\n\n' : '') +
        `export function greet(name${typed ? ': string' : ''}, log${typed ? ': GreetingLog' : ''}) {\n  const message = greeting(name);\n  log.save(message);\n  return message;\n}\n`,
    );
    files.set(
      `src/adapters/in/cli.${extension}`,
      `import { greet } from '../../application/greet.js';\n` +
        (typed ? "import type { GreetingLog } from '../../application/greet.js';\n" : '') +
        `\nexport function run(name${typed ? ': string' : ''}, log${typed ? ': GreetingLog' : ''}) {\n  return greet(name, log);\n}\n`,
    );
    files.set(
      `src/adapters/out/memoryGreetingLog.${extension}`,
      (typed ? "import type { GreetingLog } from '../../application/greet.js';\n\n" : '') +
        `export class MemoryGreetingLog${typed ? ' implements GreetingLog' : ''} {\n  messages${typed ? ': string[]' : ''} = [];\n  save(message${typed ? ': string' : ''}) {\n    this.messages.push(message);\n  }\n}\n`,
    );
    files.set(
      `src/composition/main.${extension}`,
      "import { run } from '../adapters/in/cli.js';\nimport { MemoryGreetingLog } from '../adapters/out/memoryGreetingLog.js';\n\nconst log = new MemoryGreetingLog();\nconsole.log(run('mundo', log));\n",
    );
  }
  // Publish the opt-in last: incomplete scaffolds must never activate enforcement.
  files.set(HEXAGONAL_MARKER, `${JSON.stringify(HEXAGONAL_CONFIG, null, 2)}\n`);
  return files;
}

/** Explicit human stack acceptance only. Existing files (including foreign config) are preserved. */
export function scaffoldHexagonalProject(root: string, language: string): string[] {
  const files = hexagonalTemplate(language);
  // Validate every path before writing; taskPath rejects links, including dangling links.
  const missing = [...files].filter(([relative]) => !optionalEntry(taskPath(root, relative)));
  const created: { relative: string; stat: fs.Stats }[] = [];
  try {
    for (const [relative, content] of missing) {
      taskDirectory(root, path.dirname(relative));
      const file = taskPath(root, relative);
      const fd = fs.openSync(file, 'wx', 0o600);
      const stat = fs.fstatSync(fd);
      created.push({ relative, stat });
      try {
        fs.writeFileSync(fd, content, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (error) {
    for (const { relative, stat } of created.reverse()) {
      const file = taskPath(root, relative);
      const current = optionalEntry(file);
      if (current?.ino === stat.ino && current.dev === stat.dev) fs.unlinkSync(file);
    }
    throw error;
  }
  return created.map(({ relative }) => relative);
}

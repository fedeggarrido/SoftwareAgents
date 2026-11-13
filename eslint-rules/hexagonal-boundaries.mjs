import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const policy = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('./hexagonal-policy.json', import.meta.url)), 'utf8'),
);
const allowed = {
  domain: ['domain'],
  application: ['application', 'domain'],
  in: ['in', 'application', 'domain'],
  out: ['out', 'application', 'domain'],
  composition: ['composition', 'in', 'out', 'application', 'domain'],
};
const portable = (value) => value.replaceAll('\\', '/');
const localPath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !path.isAbsolute(value) &&
  !portable(value).split('/').includes('..');

/** Deliberately small glob grammar: *, ** and ?. No executable project config. */
function matches(value, glob) {
  const pattern = glob
    .split(/(\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${pattern}$`).test(value);
}

function readConfig(cwd) {
  const file = path.join(cwd, policy.marker);
  if (!fs.existsSync(file)) return null;
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    config.version !== 1 ||
    !localPath(config.sourceRoot) ||
    !config.layers ||
    Object.keys(config.layers).length !== Object.keys(allowed).length ||
    !Object.keys(allowed).every(
      (layer) =>
        Array.isArray(config.layers[layer]) &&
        config.layers[layer].length &&
        config.layers[layer].every(localPath),
    ) ||
    !Array.isArray(config.domainAllowlist) ||
    !config.domainAllowlist.every((entry) => typeof entry === 'string') ||
    !config.aliases ||
    typeof config.aliases !== 'object' ||
    Array.isArray(config.aliases) ||
    !Object.entries(config.aliases).every(
      ([alias, target]) => alias.endsWith('/') && localPath(target),
    )
  )
    throw new Error('Marcador hexagonal inválido');
  return config;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Enforce hexagonal dependencies in explicitly opted-in projects' },
    schema: [
      { type: 'object', additionalProperties: false, properties: { root: { type: 'string' } } },
    ],
    messages: {
      boundary: 'La capa {{layer}} no puede importar {{target}} ({{dependency}}).',
      config: 'No se puede verificar la arquitectura hexagonal: {{reason}}.',
      unassigned: 'El archivo de producción no pertenece a una única capa hexagonal.',
    },
  },
  create(context) {
    const root = context.options[0]?.root ?? context.cwd;
    let config;
    try {
      config = readConfig(root);
    } catch (error) {
      return {
        Program(node) {
          context.report({ node, messageId: 'config', data: { reason: error.message } });
        },
      };
    }
    if (!config) return {};
    const layerOf = (file) => {
      const layers = Object.entries(config.layers).filter(([, globs]) =>
        globs.some((glob) => matches(file, glob)),
      );
      return layers.length === 1 ? layers[0][0] : null;
    };
    const file = portable(path.relative(root, context.filename));
    const layer = layerOf(file);
    if (!layer) {
      if (!file.startsWith(`${config.sourceRoot}/`)) return {};
      return {
        Program(node) {
          context.report({ node, messageId: 'unassigned' });
        },
      };
    }
    function check(node, source) {
      const dependency = source?.type === 'Literal' ? source.value : undefined;
      let target;
      if (typeof dependency === 'string') {
        const alias = Object.keys(config.aliases)
          .sort((a, b) => b.length - a.length)
          .find((prefix) => dependency.startsWith(prefix));
        const local = dependency.startsWith('file:') ? fileURLToPath(dependency) : dependency;
        const resolved = alias
          ? path.resolve(root, config.aliases[alias], dependency.slice(alias.length))
          : local.startsWith('.') || path.isAbsolute(local) || path.win32.isAbsolute(local)
            ? path.resolve(path.dirname(context.filename), local)
            : null;
        // Directory imports resolve to their index file inside the same folder.
        const relative = resolved && portable(path.relative(root, resolved));
        target = relative ? (layerOf(relative) ?? layerOf(`${relative}/index`)) : 'package';
        if (target && allowed[layer].includes(target)) return;
        if (target === 'package' && (layer === 'composition' || layer === 'in' || layer === 'out'))
          return;
        if (
          target === 'package' &&
          layer === 'domain' &&
          config.domainAllowlist.includes(dependency)
        )
          return;
      }
      context.report({
        node,
        messageId: 'boundary',
        data: {
          layer,
          target: target ?? 'destino desconocido',
          dependency: dependency ?? 'import dinámico',
        },
      });
    }
    return {
      ImportDeclaration(node) {
        check(node, node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source);
      },
      ExportAllDeclaration(node) {
        check(node, node.source);
      },
      ImportExpression(node) {
        check(node, node.source);
      },
      CallExpression(node) {
        // require() and module.require() / x.require() load modules the same way.
        const callee =
          node.callee.type === 'MemberExpression' && !node.callee.computed
            ? node.callee.property
            : node.callee;
        if (callee.type === 'Identifier' && callee.name === 'require')
          check(node, node.arguments[0]);
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === 'TSExternalModuleReference')
          check(node, node.moduleReference.expression);
      },
      TSImportType(node) {
        check(node, node.argument?.literal ?? node.argument);
      },
    };
  },
};

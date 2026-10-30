import { TASK_CLI_INPUT_BYTES } from './constants.js';
import { contrastRatio } from './designer.js';
import { compileSchema, validateSchema } from './schemaValidation.js';

export const DIRECTION_WEIGHTS = {
  suitability: 25,
  usability: 20,
  accessibility: 15,
  personality: 15,
  coherence: 15,
  feasibility: 10,
} as const;
const text = { type: 'string', minLength: 1, pattern: '\\S' };
const fields = [
  'id',
  'name',
  'style',
  'influences',
  'personality',
  'composition',
  'colorStrategy',
  'typographyIconography',
  'advantages',
  'limitations',
  'risks',
  'fit',
  'complexity',
] as const;
export interface ArtDirection {
  id: string;
  name: string;
  style: string;
  influences: string;
  personality: string;
  composition: string;
  colorStrategy: string;
  typographyIconography: string;
  advantages: string;
  limitations: string;
  risks: string;
  fit: string;
  complexity: string;
  scores: Record<keyof typeof DIRECTION_WEIGHTS, number>;
  total: number;
}
export interface ArtDirectionProposal {
  diagnosis: string;
  directions: ArtDirection[];
  recommendation: string;
  drawbacks: string;
}
export const ART_DIRECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['diagnosis', 'directions', 'recommendation', 'drawbacks'],
  properties: {
    diagnosis: text,
    recommendation: text,
    drawbacks: text,
    directions: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...fields, 'scores', 'total'],
        properties: {
          ...Object.fromEntries(
            fields.map((f) => [
              f,
              f === 'id' ? { type: 'string', pattern: '^[a-z][a-z0-9-]{0,40}$' } : text,
            ]),
          ),
          total: { type: 'number' },
          scores: {
            type: 'object',
            additionalProperties: false,
            required: Object.keys(DIRECTION_WEIGHTS),
            properties: Object.fromEntries(
              Object.keys(DIRECTION_WEIGHTS).map((k) => [
                k,
                { type: 'integer', minimum: 1, maximum: 5 },
              ]),
            ),
          },
        },
      },
    },
  },
};
const validate = compileSchema<ArtDirectionProposal>(ART_DIRECTION_SCHEMA);
export class SimilarDirectionsError extends Error {}
/** Conservative heuristic: identical normalized style/composition/color in two of three
 * axes means insufficient exploration. Names and prose length do not affect identity. */
export function validateArtDirection(source: string): ArtDirectionProposal {
  if (Buffer.byteLength(source) > TASK_CLI_INPUT_BYTES)
    throw new Error('ArtDirectionProposal exceeds 1 MiB');
  const proposal = validateSchema(validate, JSON.parse(source));
  if (new Set(proposal.directions.map((d) => d.id)).size !== proposal.directions.length)
    throw new Error('Duplicate direction id');
  if (!proposal.directions.some((d) => d.id === proposal.recommendation))
    throw new Error('Unknown recommendation');
  const normalize = (s: string) =>
    s
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  for (const [i, a] of proposal.directions.entries()) {
    a.total =
      Object.entries(DIRECTION_WEIGHTS).reduce(
        (sum, [k, w]) => sum + a.scores[k as keyof typeof DIRECTION_WEIGHTS] * w,
        0,
      ) / 100;
    for (const b of proposal.directions.slice(i + 1))
      if (
        (['style', 'composition', 'colorStrategy'] as const).filter(
          (k) => normalize(a[k]) === normalize(b[k]),
        ).length >= 2
      )
        throw new SimilarDirectionsError(
          'Directions share at least two visual axes; explore distinct alternatives',
        );
  }
  return proposal;
}

export interface DirectionSystem {
  colorSystem: string;
  designSystem: string;
  tokens: { name: string; value: string }[];
  approved: { foreground: string; background: string; usage: 'normal' | 'large' | 'non-text' }[];
}
export const DIRECTION_SYSTEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['colorSystem', 'designSystem', 'tokens', 'approved'],
  properties: {
    colorSystem: text,
    designSystem: text,
    tokens: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'value'],
        properties: {
          name: { type: 'string', pattern: '^--[a-z][a-z0-9-]*$' },
          value: { type: 'string', pattern: '^[^;{}@\\r\\n]+$', minLength: 1 },
        },
      },
    },
    approved: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['foreground', 'background', 'usage'],
        properties: {
          foreground: text,
          background: text,
          usage: { enum: ['normal', 'large', 'non-text'] },
        },
      },
    },
  },
};
const validateSystem = compileSchema<DirectionSystem>(DIRECTION_SYSTEM_SCHEMA);
export function validateDirectionSystem(source: string) {
  if (Buffer.byteLength(source) > TASK_CLI_INPUT_BYTES)
    throw new Error('DirectionSystem exceeds 1 MiB');
  const system = validateSchema(validateSystem, JSON.parse(source));
  const tokens = new Map(system.tokens.map((t) => [t.name, t.value]));
  if (tokens.size !== system.tokens.length) throw new Error('Duplicate tokens');
  // No imports, functions, URLs, comments or declarations can escape the token block.
  for (const { value } of system.tokens)
    if (!/^(#[a-f0-9]{6}|[a-z0-9 .,%'"-]+)$/i.test(value))
      throw new Error('Unsupported token value');
  const rgb = (name: string) => {
    const hex = tokens.get(name);
    if (!hex || !/^#[a-f0-9]{6}$/i.test(hex))
      throw new Error('Approved pairs require opaque HEX tokens');
    return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  };
  const contrasts = system.approved.map((pair) => {
    const ratio = contrastRatio(rgb(pair.foreground), rgb(pair.background));
    const threshold = pair.usage === 'normal' ? 4.5 : 3;
    if (ratio < threshold)
      throw new Error(`Approved contrast fails: ${pair.foreground}/${pair.background}`);
    return { ...pair, ratio, threshold };
  });
  return { system, contrasts };
}

/** Opaque sRGB HEX -> OKLCH (D65), using the OKLab linear-sRGB matrices. */
export function hexToOklch(hex: string): string {
  if (!/^#[a-f0-9]{6}$/i.test(hex)) throw new Error('Expected opaque HEX');
  const [r, g, b] = [1, 3, 5].map((i) => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.hypot(a, bb);
  const hue = chroma < 0.000001 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return `oklch(${(lightness * 100).toFixed(3)}% ${chroma.toFixed(5)} ${hue.toFixed(3)})`;
}

/** Replaces declarations only inside the first :root block. Never changes selectors or logic. */
export function applyDirectionTokens(css: string, tokens: DirectionSystem['tokens']): string {
  const root = /:root\s*\{([^{}]*)\}/.exec(css);
  if (!root || root.index === undefined) throw new Error('Simple :root token block required');
  let body = root[1];
  for (const { name, value } of tokens) {
    if (!/^--[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid token name');
    const declaration = new RegExp(`(^|[;\\s])${name}\\s*:[^;]+;`, 'g');
    if (!declaration.test(body)) throw new Error(`Unknown project token: ${name}`);
    body = body.replace(declaration, (_match, prefix: string) => `${prefix}${name}: ${value};`);
  }
  return (
    css.slice(0, root.index) +
    root[0].replace(root[1], body) +
    css.slice(root.index + root[0].length)
  );
}

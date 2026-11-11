/**
 * SA-155: the repository's anti-slop rules (docs/ux-audit-2026-11/reglas-antislop-y-thermos.md)
 * compiled into agent prompts. Code roles get QUALITY_RULES; the designer and any task
 * whose change zones touch UI files also get UI_RULES. Reviewers classify with REVIEW_RULES.
 */

export const QUALITY_RULES = [
  'Quality rules (mandatory; reviews block on them):',
  'Code judo first: simplify by deleting complexity, not moving it. No ad-hoc conditionals, one-off booleans, nullable modes or scattered special cases; put them behind a helper, state machine or policy.',
  'Canonical layer and reuse: logic lives in its layer; reuse existing helpers; no feature logic in shared paths; no identity wrappers or pass-through helpers.',
  'Honest types: no `as unknown as`, no `any`, no `unknown` parameters or returns without need. Every type assertion carries a `// SAFETY:` reason. No silent fallbacks that hide unclear invariants.',
  'Size and atomicity: never grow a file past 1000 lines without decomposing; no partial updates that leave state half-written.',
  'Devex: call out any change to secrets, environment variables, ports or required scripts.',
].join('\n');

export const REVIEW_RULES = [
  'Review style (thermos): report only what the diff adds or changes; trace each finding end to end; never inflate severity.',
  'Order findings by category: regression or security first, then missed simplification and branching growth, then boundaries and types, then size, then legibility. Put the category name at the start of each finding title.',
].join('\n');

export const UI_RULES = [
  'UI rules: no purple gradients, glow, glassmorphism or emoji used as icons. No colour-only status: use the StatusChip with icon and Spanish text. Body text is at least 14 px; the pixel font is for titles, buttons and numbers only. Provide hover, focus, active and disabled states and 44 px touch targets.',
  'Motion only with purpose: 100–300 ms (--duration-fast/base/slow), easing --ease-out, transform and opacity, CSS first, hover effects only under (hover: hover), never `transition: all`, `scale(0)` or ease-in on UI; respect prefers-reduced-motion. No filler copy, lorem ipsum, invented numbers or jargon in the Spanish UI.',
].join('\n');

const QUALITY_ROLES: ReadonlySet<string> = new Set(['developer', 'reviewer', 'qa-author']);
const UI_ZONE = /(^|\/)webview-ui\/|\.(tsx|css)$/;

/** Change zones of a task payload, read defensively because task data is untrusted JSON. */
function changeZones(task: unknown): string[] {
  if (typeof task !== 'object' || task === null || !('changeZones' in task)) return [];
  const zones = task.changeZones;
  return Array.isArray(zones) ? zones.filter((z): z is string => typeof z === 'string') : [];
}

/** Prompt blocks for a role and task, in a fixed order so the prompt prefix stays cacheable. */
export function qualityBlocks(role: string, task: unknown): string[] {
  const ui = role === 'product-designer' || changeZones(task).some((z) => UI_ZONE.test(z));
  return [
    ...(QUALITY_ROLES.has(role) ? [QUALITY_RULES] : []),
    ...(role === 'reviewer' ? [REVIEW_RULES] : []),
    ...(ui && (QUALITY_ROLES.has(role) || role === 'product-designer') ? [UI_RULES] : []),
  ];
}

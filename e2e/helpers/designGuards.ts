import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

/**
 * SA-151 design guards. One in-page sweep returns stable violation keys
 * (`rule|screen|viewport|detail`) that the spec compares against a reviewed
 * baseline: new keys fail, and keys that disappeared fail too so the baseline
 * only ever shrinks.
 */

export const DESIGN_BASELINE_PATH = path.join(__dirname, '..', 'design-guards.baseline.json');
export const WRITE_BASELINE = process.env.PIXEL_AGENTS_DESIGN_BASELINE === 'write';

/** Words that must not reach the Spanish UI (English chrome or internal jargon). */
export const DENIED_WORDS = [
  'Settings',
  'Layout',
  'Close',
  'Continue',
  'Welcome',
  'legacy',
  'manager',
  'WorkStore',
  'Project',
  'Executor',
];
const DENIED_PATTERNS = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /\b[A-Z]{2,}(?:_[A-Z]+)+\b/,
  /\b(?:RUNNING|REVIEW|DRAFT)\b/,
];

export interface BaselineEntry {
  key: string;
  reason: string;
}

export interface SweepOptions {
  screen: string;
  viewport: 'desktop' | 'mobile';
}

/** Run every computed-style rule in the page and return violation keys. */
export async function sweepDesign(page: Page, options: SweepOptions): Promise<string[]> {
  const raw = await page.evaluate(
    ({ denied, patterns, mobile }) => {
      const out: string[] = [];
      const deniedRe = new RegExp(`\\b(?:${denied.join('|')})\\b`);
      const patternRes = patterns.map((p) => new RegExp(p.source, p.flags));
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const label = (el: Element) => {
        const id = el.getAttribute('data-testid');
        const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)[0];
        return `${el.tagName.toLowerCase()}${id ? `[${id}]` : cls ? `.${cls}` : ''}`;
      };
      const inClosedDetails = (el: Element) => {
        const d = el.closest('details');
        return d !== null && !d.open && el.closest('summary') === null;
      };
      const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const lum = (c: number[]) => {
        const f = (v: number) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      };
      const background = (el: Element | null): number[] => {
        for (let n = el; n; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c.length >= 3 && (c[3] ?? 1) > 0.5) return c;
        }
        return parse(getComputedStyle(document.body).backgroundColor);
      };
      const short = (t: string) => t.trim().replace(/\s+/g, ' ').slice(0, 40);

      // Text rules: size, contrast, language, mid-word wraps.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = new Set<Element>();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement;
        const text = node.textContent?.trim() ?? '';
        if (!el || !text || seen.has(el) || !visible(el) || inClosedDetails(el)) continue;
        if (el.closest('script,style,canvas,[aria-hidden="true"],.xterm')) continue;
        seen.add(el);
        const s = getComputedStyle(el);
        const size = parseFloat(s.fontSize);
        const body = el.closest('p,li') !== null;
        if (size < 12 || (body && size < 14))
          out.push(`text-size|${label(el)}|${Math.round(size)}px|${short(text)}`);
        const fg = parse(s.color);
        const bg = background(el);
        if (fg.length >= 3 && bg.length >= 3 && (fg[3] ?? 1) > 0.5) {
          const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
          const ratio = (a + 0.05) / (b + 0.05);
          const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
          if (ratio < (large ? 3 : 4.5))
            out.push(`contrast|${label(el)}|${ratio.toFixed(1)}|${short(text)}`);
        }
        const word =
          deniedRe.exec(text)?.[0] ?? patternRes.find((r) => r.test(text))?.exec(text)?.[0];
        if (word) out.push(`language|${label(el)}|${word}`);
        if (el.closest('button,label,[role="tab"]') && !/\s/.test(text)) {
          const range = document.createRange();
          range.selectNodeContents(node);
          if (range.getClientRects().length > 1) out.push(`word-break|${label(el)}|${short(text)}`);
        }
      }

      // Horizontal overflow on the page and on panels.
      if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push('overflow|page|');
      for (const el of Array.from(
        document.querySelectorAll('[data-testid="panel-window"],[role="dialog"]'),
      ))
        if (visible(el) && (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1)
          out.push(`overflow|${label(el)}|`);

      // Touch targets on mobile.
      if (mobile)
        for (const el of Array.from(
          document.querySelectorAll('button,[role="tab"],a[href],input,select'),
        )) {
          if (!visible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 44 || r.height < 44)
            out.push(
              `touch-target|${label(el)}|${short(el.getAttribute('aria-label') ?? el.textContent ?? '')}`,
            );
        }

      // Motion (SA-160): no transition:all, no ease-in, chrome transitions ≤ 300 ms.
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const s = getComputedStyle(el);
        if (s.transitionDuration === '0s' && s.animationName === 'none') continue;
        if (/\ball\b/.test(s.transitionProperty) && s.transitionDuration !== '0s')
          out.push(`motion-all|${label(el)}|`);
        if (/(^|,\s*)ease-in(\s*,|$)/.test(s.transitionTimingFunction))
          out.push(`motion-ease-in|${label(el)}|`);
        const longest = Math.max(
          ...s.transitionDuration
            .split(',')
            .map((d) => parseFloat(d) * (d.includes('ms') ? 1 : 1000)),
        );
        if (longest > 300) out.push(`motion-duration|${label(el)}|${longest}ms`);
      }
      return out;
    },
    {
      denied: DENIED_WORDS,
      patterns: DENIED_PATTERNS.map((r) => ({ source: r.source, flags: r.flags })),
      mobile: options.viewport === 'mobile',
    },
  );
  return [...new Set(raw)].map((key) => `${options.screen}|${options.viewport}|${key}`);
}

/** Layer rule: the element at the centre of `selector` is that element (nothing covers it). */
export async function coveredBy(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (!top || el.contains(top)) return null;
    return `${top.tagName.toLowerCase()}.${(top.getAttribute('class') ?? '').split(/\s+/)[0]}`;
  }, selector);
}

export function readBaseline(): BaselineEntry[] {
  if (!fs.existsSync(DESIGN_BASELINE_PATH)) return [];
  // SAFETY: the file is written only by writeBaseline below with this shape.
  return JSON.parse(fs.readFileSync(DESIGN_BASELINE_PATH, 'utf8')) as BaselineEntry[];
}

/** Merge one screen's keys into the baseline, keeping existing reasons. */
export function writeBaseline(screen: string, viewport: string, keys: string[]): void {
  const prefix = `${screen}|${viewport}|`;
  const previous = readBaseline();
  const reasons = new Map(previous.map((e) => [e.key, e.reason]));
  const kept = previous.filter((e) => !e.key.startsWith(prefix));
  const fresh = keys.map((key) => ({
    key,
    reason: reasons.get(key) ?? 'Known at SA-151 start; to burn down in SA-124/SA-152/SA-160.',
  }));
  const all = [...kept, ...fresh].sort((a, b) => a.key.localeCompare(b.key));
  fs.writeFileSync(DESIGN_BASELINE_PATH, `${JSON.stringify(all, null, 2)}\n`);
}

/** Compare one screen's keys with its baseline slice. */
export function diffBaseline(
  screen: string,
  viewport: string,
  keys: string[],
): { added: string[]; fixed: string[] } {
  const prefix = `${screen}|${viewport}|`;
  const known = new Set(
    readBaseline()
      .filter((e) => e.key.startsWith(prefix))
      .map((e) => e.key),
  );
  const now = new Set(keys);
  return {
    added: keys.filter((k) => !known.has(k)),
    fixed: [...known].filter((k) => !now.has(k)),
  };
}

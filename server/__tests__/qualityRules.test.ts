import { describe, expect, it } from 'vitest';

import { QUALITY_RULES, qualityBlocks, REVIEW_RULES, UI_RULES } from '../src/qualityRules.js';

describe('qualityBlocks (SA-155)', () => {
  it('gives code roles the quality rules and only reviewers the thermos order', () => {
    expect(qualityBlocks('developer', {})).toEqual([QUALITY_RULES]);
    expect(qualityBlocks('qa-author', {})).toEqual([QUALITY_RULES]);
    expect(qualityBlocks('reviewer', {})).toEqual([QUALITY_RULES, REVIEW_RULES]);
    expect(qualityBlocks('researcher', {})).toEqual([]);
  });

  it('adds UI rules for the designer and for tasks touching UI zones', () => {
    expect(qualityBlocks('product-designer', {})).toEqual([UI_RULES]);
    expect(qualityBlocks('developer', { changeZones: ['webview-ui/src/App.tsx'] })).toEqual([
      QUALITY_RULES,
      UI_RULES,
    ]);
    expect(qualityBlocks('developer', { changeZones: ['server/src/a.ts'] })).toEqual([
      QUALITY_RULES,
    ]);
  });

  it('treats malformed task data as having no zones', () => {
    expect(qualityBlocks('developer', { changeZones: 'webview-ui/x.tsx' })).toEqual([
      QUALITY_RULES,
    ]);
    expect(qualityBlocks('developer', null)).toEqual([QUALITY_RULES]);
  });
});

import { createHash } from 'node:crypto';

import { FEATURE_PLAN_SECTIONS } from '../../core/src/featurePlan.js';
import type { FeaturePlan } from '../../core/src/messages.js';
import type { ProjectConfig } from '../../core/src/project.js';
import { FEATURE_PLAN_HEADINGS } from './constants.js';
import { featureDocument } from './featureArtifacts.js';
import type { WorkStore } from './workstore/WorkStore.js';

export type PlanStore = Pick<WorkStore, 'getFeature' | 'getTask' | 'getDesign'>;

export class StaleFeaturePlan extends Error {
  constructor() {
    super('stale_revision');
  }
}

/** Only explicit Markdown headings contribute specialized sections. Text stays literal. */
export function designSection(source: string | null, heading: RegExp): string | null {
  const lines = source?.split(/\r?\n/) ?? [];
  const result: string[] = [];
  let depth = 0;
  let fence: string | undefined;
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && marker) fence = marker;
    else if (fence && marker?.startsWith(fence) && /^\s*(`{3,}|~{3,})\s*$/.test(line))
      fence = undefined;
    const match = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match && depth && match[1].length <= depth) depth = 0;
    if (match && heading.test(match[2])) depth = match[1].length;
    if (depth) result.push(line);
  }
  return result.join('\n').trim() || null;
}

/** This projection reads only already-bound artifacts, with the CLI's Git fence. */
export function projectFeaturePlan(
  store: PlanStore,
  config: ProjectConfig,
  key: string,
): FeaturePlan {
  const feature = store.getFeature(key);
  if (!feature) throw new Error('Unknown Feature');
  const { spec, sources } = featureDocument(store, config, feature);
  const content = {
    requirements: sources.requirements,
    architecture: sources.design,
    tasks: sources.dag,
    tests: designSection(sources.design, FEATURE_PLAN_HEADINGS.tests),
    ci: designSection(sources.design, FEATURE_PLAN_HEADINGS.ci),
    security: designSection(sources.design, FEATURE_PLAN_HEADINGS.security),
    documentation: designSection(sources.design, FEATURE_PLAN_HEADINGS.documentation),
  };
  // Operational approval and approval of this exact plan are distinct.
  const specApproved = ['approved', 'ready_to_merge'].includes(feature.status);
  const revision = createHash('sha256')
    .update(JSON.stringify({ key, specSha: feature.git_sha, sources }))
    .digest('hex');
  return {
    key,
    title: spec.title,
    specSha: feature.git_sha,
    revision,
    specApproved,
    approved: specApproved && feature.approved_plan_revision === revision,
    sections: FEATURE_PLAN_SECTIONS.map((section) => ({
      ...section,
      content: content[section.id],
    })),
  };
}

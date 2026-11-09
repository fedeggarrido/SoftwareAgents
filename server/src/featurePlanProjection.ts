import { createHash } from 'node:crypto';

import { parseDocument } from 'yaml';

import { FEATURE_PLAN_SECTIONS } from '../../core/src/featurePlan.js';
import type { FeaturePlan } from '../../core/src/messages.js';
import type { ProjectConfig } from '../../core/src/project.js';
import { FEATURE_PLAN_EXCLUSION_RULE, FEATURE_PLAN_HEADINGS } from './constants.js';
import { featureDocument } from './featureArtifacts.js';
import { featureMerged } from './featureCompletion.js';
import { analyzeTaskDag, parseTaskDag, parseTechnicalDesign } from './taskDag.js';
import { readMainAncestors } from './workstore/readOnlyWorkStore.js';
import type { FeatureRunRecord, WorkStore } from './workstore/WorkStore.js';

export type PlanStore = Pick<WorkStore, 'getFeature' | 'getTask' | 'getDesign'> & {
  getFeatureRun(key: string): Pick<FeatureRunRecord, 'state'> | undefined;
};

function yamlValue(source: string): unknown {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new Error('Invalid plan YAML');
  return document.toJS({ maxAliasCount: 100 });
}

/** Formatting is removed for display only. The original document remains available. */
function readableSection(source: string | null): string[] {
  let fence: string | undefined;
  return (source?.split(/\r?\n/) ?? [])
    .filter((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (!fence && marker) {
        fence = marker;
        return false;
      }
      if (fence) {
        if (marker?.startsWith(fence) && /^\s*(`{3,}|~{3,})\s*$/.test(line)) fence = undefined;
        return false;
      }
      return !/^\s*#{1,6}\s/.test(line);
    })
    .map((line) => line.replace(/^\s*(?:[-*+] |\d+\. )/, '').trim())
    .filter(Boolean);
}

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
  const frontMatter =
    sources.design && /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(sources.design);
  if (sources.design && !frontMatter) throw new Error('Missing TechnicalDesign metadata');
  const design = frontMatter ? parseTechnicalDesign(yamlValue(frontMatter[1])) : null;
  const designBody = frontMatter ? sources.design!.slice(frontMatter[0].length) : null;
  const dag = sources.dag === null ? null : parseTaskDag(yamlValue(sources.dag));
  if (design && design.feature !== key) throw new Error('Foreign TechnicalDesign');
  if (dag && !analyzeTaskDag(dag, spec).valid) throw new Error('Invalid plan DAG');
  const titles = new Map(dag?.tasks.map((task) => [task.key, task.title]));
  const acceptance = spec.acceptance.map(
    (criterion) =>
      `${criterion.id} · Dado ${criterion.given}, cuando ${criterion.when}, ${criterion.then}`,
  );
  const summary = {
    goal: spec.goal,
    userValue: spec.userValue,
    outOfScope: spec.rules.filter((rule) => FEATURE_PLAN_EXCLUSION_RULE.test(rule.trim())),
    risks: design?.risks ?? [],
    acceptance,
    tasks: (dag?.tasks ?? []).map((task) => ({
      key: task.key,
      title: task.title,
      size: task.size,
      dependencies: task.dependsOn.map((key) => titles.get(key)!),
    })),
  };
  const content = {
    requirements: sources.requirements,
    architecture: sources.design,
    tasks: sources.dag,
    tests: designSection(designBody, FEATURE_PLAN_HEADINGS.tests),
    ci: designSection(designBody, FEATURE_PLAN_HEADINGS.ci),
    security: designSection(designBody, FEATURE_PLAN_HEADINGS.security),
    documentation: designSection(designBody, FEATURE_PLAN_HEADINGS.documentation),
  };
  const items = {
    requirements: [
      spec.goal,
      spec.userValue,
      ...spec.flows,
      ...spec.rules,
      ...spec.edgeCases,
      ...acceptance,
      ...spec.openQuestions,
    ],
    architecture: [...(design?.components ?? []), ...readableSection(designBody)],
    tasks: summary.tasks.map((task) => task.title),
    tests: [
      ...readableSection(content.tests),
      ...(dag?.tasks.filter((task) => task.type === 'qa').map((task) => task.title) ?? []),
    ],
    ci: readableSection(content.ci),
    security: readableSection(content.security),
    documentation: [
      ...readableSection(content.documentation),
      ...(dag?.tasks.filter((task) => task.type === 'doc').map((task) => task.title) ?? []),
    ],
  };
  // Operational approval and approval of this exact plan are distinct.
  const specApproved = ['approved', 'ready_to_merge'].includes(feature.status);
  const revision = createHash('sha256')
    .update(JSON.stringify({ key, specSha: feature.git_sha, sources }))
    .digest('hex');
  const approved = specApproved && feature.approved_plan_revision === revision;
  const tasks = (dag?.tasks ?? []).map((task) => ({ status: store.getTask(task.key)?.status }));
  const finished = tasks.length > 0 && tasks.every((task) => task.status === 'DONE');
  const merged =
    finished &&
    featureMerged(key, tasks, store.getFeatureRun(key)?.state, readMainAncestors(config.repoRoot));
  return {
    key,
    title: spec.title,
    specSha: feature.git_sha,
    revision,
    specApproved,
    approved,
    approvalState: merged
      ? 'merged'
      : finished || feature.status === 'ready_to_merge'
        ? 'finished'
        : approved
          ? 'approved'
          : feature.approved_plan_revision
            ? 'changed'
            : specApproved
              ? 'unbound'
              : 'pending',
    summary,
    sections: FEATURE_PLAN_SECTIONS.map((section) => ({
      ...section,
      content: content[section.id],
      items: items[section.id],
    })),
  };
}

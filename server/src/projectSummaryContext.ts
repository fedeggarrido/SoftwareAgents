import type { FeatureRow, ProjectSummaryItem } from '../../core/src/messages.js';
import type { ProjectConfig } from '../../core/src/project.js';
import { readTaskInput } from './commands/taskFiles.js';
import { FEATURE_IDEAS_DIRECTORY, PROJECT_SUMMARY_TEXT_LIMIT } from './constants.js';
import { readIdeas } from './featureIdeas.js';
import { designSection, readFeaturePlan } from './featurePlan.js';
import { featureDisplayText } from './featuresView.js';

export interface SummaryContext {
  goals: ProjectSummaryItem[];
  risks: ProjectSummaryItem[];
  nextSteps: ProjectSummaryItem[];
  notices: string[];
}

/** Reuse the Features sanitization boundary and bound display length. */
export function summaryText(value: string): string {
  const text = (featureDisplayText(value) ?? '').trim();
  return text.length > PROJECT_SUMMARY_TEXT_LIMIT
    ? `${text.slice(0, PROJECT_SUMMARY_TEXT_LIMIT).trimEnd()}…`
    : text;
}

function ideaSection(source: string, heading: RegExp): string | null {
  const section = designSection(source, heading);
  if (!section) return null;
  const text = section.split(/\r?\n/).slice(1).join(' ').trim();
  return text ? summaryText(text) : null;
}

/** Read the same bound specs as the plan panel. Missing artifacts stay explicit. */
export function readSummaryContext(config: ProjectConfig, features: FeatureRow[]): SummaryContext {
  const result: SummaryContext = { goals: [], risks: [], nextSteps: [], notices: [] };
  for (const feature of features) {
    try {
      const plan = readFeaturePlan(config, feature.key);
      result.goals.push({ key: feature.key, text: summaryText(plan.summary.goal), at: null });
      result.risks.push(
        ...plan.summary.risks.map((text, index) => ({
          key: `${feature.key}-risk-${index}`,
          text: summaryText(text),
          at: null,
        })),
      );
      if (['pending', 'changed', 'unbound'].includes(plan.approvalState))
        result.nextSteps.push({
          key: `${feature.key}-plan`,
          text: `Revisar y aprobar el plan de ${feature.title ?? feature.key}`,
          at: null,
        });
    } catch {
      result.notices.push(
        `Objetivo y riesgos de ${feature.key} no disponibles en su especificación vinculada.`,
      );
    }
  }
  const ideas = readIdeas('summary-context', true, config.repoRoot);
  if (ideas.errorCode || ideas.projectId !== config.project.id) {
    result.notices.push('No se pudieron leer las ideas pendientes.');
    return result;
  }
  for (const idea of ideas.ideas) {
    try {
      const source = readTaskInput(
        config.repoRoot,
        `${FEATURE_IDEAS_DIRECTORY}/${config.project.id}/${idea.key}.md`,
      );
      const answers = designSection(source, /^Respuestas$/);
      const goal = ideaSection(answers ?? '', /^Objetivo$/) ?? ideaSection(source, /^Idea$/);
      if (goal) result.goals.push({ key: idea.key, text: goal, at: null });
      const risk = ideaSection(answers ?? '', /^Riesgos$/);
      if (risk) result.risks.push({ key: `${idea.key}-risk`, text: risk, at: null });
      result.nextSteps.push({
        key: idea.key,
        text: `Revisar la idea ${idea.key} y preparar sus requisitos`,
        at: null,
      });
    } catch {
      result.notices.push(`No se pudo leer el objetivo de la idea ${idea.key}.`);
    }
  }
  return result;
}

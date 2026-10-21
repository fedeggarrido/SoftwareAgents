import * as taskDagSchema from '../../core/schemas/task-dag.schema.json';
import * as technicalDesignSchema from '../../core/schemas/technical-design.schema.json';
import type { FeatureSpec } from '../../core/src/featureSpec.js';
import type { TaskDag, TaskDagAnalysis, TaskDagIssue } from '../../core/src/taskDag.js';
import type { TechnicalDesign } from '../../core/src/technicalDesign.js';
import { compileSchema, validateSchema } from './schemaValidation.js';

// Pure: no I/O, clock or randomness. Whether B may start before A finishes is decided
// here, deterministically, never by a Model.

const validateDag = compileSchema<TaskDag>(taskDagSchema);
const validateDesign = compileSchema<TechnicalDesign>(technicalDesignSchema);

/** Complete immutable content; task and set-valued field ordering is immaterial. */
export function taskDeclaration(feature: string, task: TaskDag['tasks'][number]): string {
  return JSON.stringify({
    feature,
    key: task.key,
    type: task.type,
    title: task.title,
    description: task.description,
    acceptanceRefs: [...task.acceptanceRefs].sort(),
    dependsOn: [...task.dependsOn].sort(),
    agentRole: task.agentRole,
    size: task.size,
    ...(task.changeZones ? { changeZones: [...task.changeZones].sort() } : {}),
    ...(task.testZones ? { testZones: [...task.testZones].sort() } : {}),
    ...(task.parallelizable !== undefined ? { parallelizable: task.parallelizable } : {}),
  });
}

export function taskDagDeclaration(dag: TaskDag): string {
  return JSON.stringify(dag.tasks.map((task) => taskDeclaration(dag.feature, task)).sort());
}

/** Only unfinished descendants in the validated, registered DAG can take over an AC. */
export function deferredAcceptanceCoverage(
  dag: TaskDag,
  key: string,
  isDone: (key: string) => boolean,
): Record<string, string[]> {
  const descendants = new Set([key]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of dag.tasks)
      if (!descendants.has(task.key) && task.dependsOn.some((dep) => descendants.has(dep))) {
        descendants.add(task.key);
        changed = true;
      }
  }
  return Object.fromEntries(
    (dag.tasks.find((task) => task.key === key)?.acceptanceRefs ?? []).map((ac) => [
      ac,
      dag.tasks
        .filter(
          (task) =>
            task.key !== key &&
            descendants.has(task.key) &&
            !isDone(task.key) &&
            task.acceptanceRefs.includes(ac),
        )
        .map((task) => task.key)
        .sort(),
    ]),
  );
}

/** Shape only; throws SchemaValidationError. Graph rules live in analyzeTaskDag. */
export function parseTaskDag(value: unknown): TaskDag {
  return validateSchema(validateDag, value);
}

/** Validates already-parsed TechnicalDesign front matter; throws SchemaValidationError. */
export function parseTechnicalDesign(value: unknown): TechnicalDesign {
  return validateSchema(validateDesign, value);
}

/**
 * Checks a schema-valid DAG against its FeatureSpec: duplicate and foreign keys, dangling
 * dependencies, cycles (with their path) and acceptance coverage. Order and levels are
 * computed only when the graph is well formed; ties always follow declaration order.
 * Cycle detection reports at least one cycle per strongly connected tangle, not every
 * elementary cycle.
 */
export function analyzeTaskDag(
  dag: TaskDag,
  spec: Pick<FeatureSpec, 'key' | 'acceptance'>,
): TaskDagAnalysis {
  const issues: TaskDagIssue[] = [];

  // First declaration wins; later duplicates are reported and excluded from the graph.
  const index = new Map<string, number>();
  const duplicates = new Map<string, number[]>();
  dag.tasks.forEach((task, i) => {
    const first = index.get(task.key);
    if (first === undefined) {
      index.set(task.key, i);
    } else {
      const seen = duplicates.get(task.key) ?? [first];
      seen.push(i);
      duplicates.set(task.key, seen);
    }
  });
  for (const [key, indices] of duplicates) issues.push({ code: 'duplicate_key', key, indices });

  for (const key of index.keys()) {
    if (!key.startsWith(`${dag.feature}-`)) {
      issues.push({ code: 'foreign_key', key, feature: dag.feature });
    }
  }

  let dangling = false;
  for (const task of dag.tasks) {
    for (const dep of task.dependsOn) {
      if (!index.has(dep)) {
        dangling = true;
        issues.push({ code: 'dangling_dependency', task: task.key, dependsOn: dep });
      }
    }
  }

  const nodes = [...index.entries()].map(([key, i]) => ({
    key,
    deps: dag.tasks[i].dependsOn.filter((dep) => index.has(dep)),
  }));
  const depsOf = new Map(nodes.map((node) => [node.key, node.deps]));

  const cycles = findCycles(nodes, depsOf, index);
  for (const path of cycles) issues.push({ code: 'cycle', path });

  if (dag.feature !== spec.key) {
    issues.push({ code: 'feature_mismatch', dagFeature: dag.feature, specFeature: spec.key });
  }

  const acceptanceIds = new Set(spec.acceptance.map((criterion) => criterion.id));
  const covered = new Set<string>();
  for (const task of dag.tasks) {
    for (const ref of task.acceptanceRefs) {
      if (acceptanceIds.has(ref)) covered.add(ref);
      else issues.push({ code: 'unknown_acceptance', task: task.key, acceptanceRef: ref });
    }
  }
  for (const id of acceptanceIds) {
    if (!covered.has(id)) issues.push({ code: 'uncovered_acceptance', acceptanceId: id });
  }

  const wellFormed = duplicates.size === 0 && !dangling && cycles.length === 0;
  const sorted = wellFormed ? topologicalLevels(nodes, depsOf, index) : null;
  return {
    valid: issues.length === 0,
    issues,
    order: sorted?.order ?? null,
    levels: sorted?.levels ?? null,
  };
}

/** Depth-first search in declaration order; each back edge yields one closed path. */
function findCycles(
  nodes: { key: string; deps: string[] }[],
  depsOf: Map<string, string[]>,
  index: Map<string, number>,
): string[][] {
  const state = new Map<string, 'active' | 'done'>();
  const stack: string[] = [];
  const frames: { key: string; nextDep: number }[] = [];
  const cycles: string[][] = [];

  const enter = (key: string): void => {
    state.set(key, 'active');
    stack.push(key);
    frames.push({ key, nextDep: 0 });
  };

  for (const node of nodes) {
    if (state.has(node.key)) continue;
    enter(node.key);
    while (frames.length) {
      const frame = frames[frames.length - 1];
      const deps = depsOf.get(frame.key)!;
      if (frame.nextDep === deps.length) {
        frames.pop();
        stack.pop();
        state.set(frame.key, 'done');
        continue;
      }

      // Resume the parent at its next dependency after the child finishes.
      const dep = deps[frame.nextDep++];
      const seen = state.get(dep);
      if (seen === 'active') {
        cycles.push(rotateToEarliest(stack.slice(stack.indexOf(dep)), index));
      } else if (seen === undefined) {
        enter(dep);
      }
    }
  }
  return cycles;
}

/** Starts the cycle at its earliest-declared task and closes it, e.g. `[A, B, A]`. */
function rotateToEarliest(cycle: string[], index: Map<string, number>): string[] {
  let start = 0;
  cycle.forEach((key, i) => {
    if (index.get(key)! < index.get(cycle[start])!) start = i;
  });
  const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
  return [...rotated, rotated[0]];
}

/**
 * Kahn's algorithm taking the earliest-declared ready task each step, so an input that is
 * already topologically sorted comes back unchanged.
 */
function topologicalLevels(
  nodes: { key: string; deps: string[] }[],
  depsOf: Map<string, string[]>,
  index: Map<string, number>,
): { order: string[]; levels: string[][] } {
  const pending = new Map(nodes.map((node) => [node.key, node.deps.length]));
  const dependents = new Map<string, string[]>(nodes.map((node) => [node.key, []]));
  for (const node of nodes) for (const dep of node.deps) dependents.get(dep)!.push(node.key);

  const byDeclaration = (a: string, b: string) => index.get(a)! - index.get(b)!;
  const ready = nodes.filter((node) => node.deps.length === 0).map((node) => node.key);
  const order: string[] = [];
  while (ready.length) {
    ready.sort(byDeclaration);
    const key = ready.shift()!;
    order.push(key);
    for (const next of dependents.get(key)!) {
      const left = pending.get(next)! - 1;
      pending.set(next, left);
      if (left === 0) ready.push(next);
    }
  }

  const level = new Map<string, number>();
  const levels: string[][] = [];
  for (const key of order) {
    const n = Math.max(-1, ...depsOf.get(key)!.map((dep) => level.get(dep)!)) + 1;
    level.set(key, n);
    (levels[n] ??= []).push(key);
  }
  for (const group of levels) group.sort(byDeclaration);
  return { order, levels };
}

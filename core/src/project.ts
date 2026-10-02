/** Repository-authored identity and paths. This document cannot grant authority. */
export interface ProjectManifest {
  apiVersion: 'softwareagents.io/v1alpha1';
  kind: 'Project';
  id: string;
  name: string;
  repo: { remote: string; defaultBranch: string };
  brain: { path: string };
  clickup?: { workspaceId: string; folderId: string; listIds: string[] };
  legacy?: { boardFile: string };
}

export type AutonomyLevel = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';

export interface ProjectAutopilotConfig {
  command: string[];
  stateFile?: string;
}

/** Operator-owned policy in ~/.pixel-agents/config.json, never in Project Brain. */
export interface ProjectOperatorConfig {
  autonomyLevel: AutonomyLevel;
  allowedExecutors: string[];
  binaryPaths?: Record<string, string>;
  /** Minimum remaining quota percentages, by executor. */
  quotaThresholds?: Record<string, number>;
  concurrency?: { maxExecutions: number; perExecutor?: Record<string, number> };
  budgets?: { maxTokens?: number; maxCostUsd?: number; maxExecutionSeconds?: number };
  autopilot?: ProjectAutopilotConfig;
}

export interface ProjectConfig {
  project: ProjectManifest;
  repoRoot: string;
  /** Canonical paths contained within repoRoot. */
  paths: { brain: string; boardFile?: string };
  operator: ProjectOperatorConfig;
}

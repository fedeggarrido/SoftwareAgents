import type { ModelTier, ModelTierPolicy } from './modelTier.js';

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

/** Explicit Operator prices in USD per million tokens; no inferred tariffs. */
export interface TelemetryModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreate?: number;
}

export interface TelemetryConfig {
  otlp?: { enabled: boolean; endpoint: string; headers?: Record<string, string> };
  prices?: Record<string, TelemetryModelPrice>;
}

/** Operator-owned policy in ~/.pixel-agents/config.json, never in Project Brain. */
export interface ProjectOperatorConfig {
  autonomyLevel: AutonomyLevel;
  allowedExecutors: string[];
  modelTiers?: ModelTierPolicy;
  telemetry?: TelemetryConfig;
  /** Runtime-only branch publication. Absent/disabled means no push. */
  developer?: { pushBranch: { enabled: boolean; remote: string } };
  /**
   * SA-092: tiers each Executor may run, narrowing what modelTiers offers. Absent
   * (or no entry) = every catalog tier; an empty list blocks that Executor.
   */
  executorLevels?: Partial<Record<'claude' | 'codex', ModelTier[]>>;
  /** Additive protected paths/globs from Operator config only. */
  protectedPaths?: string[];
  binaryPaths?: Record<string, string>;
  /** Optional Operator-owned Claude profile shared by worker launches and probes. */
  executors?: { claude?: { configDir?: string } };
  /** Minimum remaining quota percentages, by executor. */
  quotaThresholds?: Record<string, number>;
  concurrency?: { maxExecutions?: number; perExecutor?: Record<string, number> };
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

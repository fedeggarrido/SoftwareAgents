import * as fs from 'fs';
import * as path from 'path';

/**
 * SA-163: which automatic tests a Managed Project should have, from what it
 * already is. Detection only reads manifest files; it never installs anything.
 */
export type ProjectKind = 'web' | 'api' | 'cli' | 'library';
export type TestLayer = 'unit' | 'e2e' | 'design' | 'contract';
export type TestRunner = 'vitest' | 'jest' | 'node-test' | 'playwright' | 'pytest' | 'cargo' | 'go';

export interface TestProfile {
  kind: ProjectKind;
  /** Layers this kind of project needs, in the order they should exist. */
  layers: readonly TestLayer[];
  unit: TestRunner | null;
  e2e: TestRunner | null;
  /** Dev dependencies the owner must approve before the layers can run. */
  missing: readonly string[];
}

const LAYERS: Record<ProjectKind, readonly TestLayer[]> = {
  web: ['unit', 'e2e', 'design'],
  api: ['unit', 'contract'],
  cli: ['unit', 'contract'],
  library: ['unit'],
};

const WEB_DEPENDENCIES = ['react', 'vue', 'svelte', 'solid-js', 'preact', 'next', 'astro'];
const API_DEPENDENCIES = ['express', 'fastify', 'koa', 'hono', '@nestjs/core'];
const PYTHON_WEB = /\b(django|flask|fastapi)\b/i;

interface PackageJson {
  bin?: unknown;
  workspaces?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readText(root: string, file: string): string | null {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
}

/** Workspace member manifests (`dir` or `dir/*` patterns), so a monorepo root reuses their runners. */
function workspaceMembers(pkg: PackageJson, root: string): PackageJson[] {
  const patterns = Array.isArray(pkg.workspaces)
    ? pkg.workspaces.filter((pattern): pattern is string => typeof pattern === 'string')
    : [];
  const dirs = patterns.flatMap((pattern) => {
    if (!pattern.endsWith('/*')) return [pattern];
    const parent = pattern.slice(0, -2);
    try {
      return fs.readdirSync(path.join(root, parent)).map((name) => `${parent}/${name}`);
    } catch {
      return [];
    }
  });
  return dirs.flatMap((dir) => {
    const text = readText(root, `${dir}/package.json`);
    if (text === null) return [];
    try {
      // SAFETY: only optional, separately checked fields are read from the manifest.
      return [JSON.parse(text) as PackageJson];
    } catch {
      return [];
    }
  });
}

function nodeProfile(pkg: PackageJson, root: string): TestProfile {
  const members = [pkg, ...workspaceMembers(pkg, root)];
  const deps = Object.assign({}, ...members.flatMap((m) => [m.dependencies, m.devDependencies]));
  const has = (name: string) => Object.hasOwn(deps, name);
  const browserPage = has('vite') && fs.existsSync(path.join(root, 'index.html'));
  // A declared binary wins: a terminal UI built with React (Ink) is still a CLI.
  const kind: ProjectKind = members.some((m) => m.bin !== undefined)
    ? 'cli'
    : WEB_DEPENDENCIES.some(has) || browserPage
      ? 'web'
      : API_DEPENDENCIES.some(has)
        ? 'api'
        : 'library';
  // Reuse what the project already runs; node:test needs nothing new.
  const unit: TestRunner = has('vitest') ? 'vitest' : has('jest') ? 'jest' : 'node-test';
  const e2e: TestRunner | null = kind === 'web' ? 'playwright' : null;
  const missing = e2e && !has('@playwright/test') ? ['@playwright/test'] : [];
  return { kind, layers: LAYERS[kind], unit, e2e, missing };
}

function pythonProfile(manifest: string): TestProfile {
  const kind: ProjectKind = PYTHON_WEB.test(manifest)
    ? 'api'
    : /\[project\.scripts\]|console_scripts/.test(manifest)
      ? 'cli'
      : 'library';
  return {
    kind,
    layers: LAYERS[kind],
    unit: 'pytest',
    e2e: null,
    missing: /\bpytest\b/.test(manifest) ? [] : ['pytest'],
  };
}

/** The test profile of the project at `root`, or null when its stack is not recognised. */
export function detectTestProfile(root: string): TestProfile | null {
  const pkg = readText(root, 'package.json');
  if (pkg !== null) {
    try {
      // SAFETY: only optional, separately checked fields are read from the manifest.
      return nodeProfile(JSON.parse(pkg) as PackageJson, root);
    } catch {
      return null;
    }
  }
  const python = ['pyproject.toml', 'requirements.txt', 'setup.py']
    .map((file) => readText(root, file))
    .filter((text): text is string => text !== null);
  if (python.length) return pythonProfile(python.join('\n'));
  const cargo = readText(root, 'Cargo.toml');
  if (cargo !== null) {
    const kind: ProjectKind =
      /\[\[bin\]\]|src\/main\.rs/.test(cargo) || fs.existsSync(path.join(root, 'src', 'main.rs'))
        ? 'cli'
        : 'library';
    return { kind, layers: LAYERS[kind], unit: 'cargo', e2e: null, missing: [] };
  }
  if (readText(root, 'go.mod') !== null) {
    const kind: ProjectKind = fs.existsSync(path.join(root, 'main.go')) ? 'cli' : 'library';
    return { kind, layers: LAYERS[kind], unit: 'go', e2e: null, missing: [] };
  }
  return null;
}

const LAYER_RULES: Record<TestLayer, string> = {
  unit: 'unit: domain and use-case behaviour, fast and deterministic',
  e2e: 'e2e: a real browser drives each criterion end to end and saves a screenshot of every state it checks',
  design:
    'design: every screen is swept for text contrast, a 14 px minimum body size, accessible names and 44 px touch targets',
  contract:
    'contract: the public interface runs as a black box (CLI arguments, exit codes and output, or HTTP status and response schema)',
};

/** Roles that write code or tests; only they receive the project's test layers. */
const TEST_ROLES: ReadonlySet<string> = new Set(['developer', 'integrations', 'qa-author']);

/** Prompt blocks that turn a task's acceptance criteria into the tests this project needs. */
export function testingBlocks(role: string, profile: TestProfile | null | undefined): string[] {
  return profile && TEST_ROLES.has(role) ? [testingRules(profile)] : [];
}

function testingRules(profile: TestProfile): string {
  const runners = [profile.unit, profile.e2e].filter((runner) => runner !== null).join(', ');
  return [
    `Project tests (SA-163): this is a ${profile.kind} project; use ${runners}.`,
    'Every acceptance criterion of the task becomes an automatic test before the task closes. Required layers:',
    ...profile.layers.map((layer) => `- ${LAYER_RULES[layer]}`),
    "Reuse the runners and helpers the project already has; tests run isolated in temporary home and data directories, never against the user's real profiles or services.",
    profile.missing.length
      ? `Not installed yet: ${profile.missing.join(', ')}. Never install it; write the tests and report the missing dependency so the owner can approve it.`
      : 'Do not add new test dependencies.',
  ].join('\n');
}

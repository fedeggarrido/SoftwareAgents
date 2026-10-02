import * as path from 'path';

import type { ProjectConfig } from '../../core/src/project.js';
import { resolveInside } from './pathGuard.js';
import { loadProjectConfig } from './projectConfig.js';

export type BoardSelection =
  | { kind: 'legacy' }
  | { kind: 'project'; project: ProjectConfig }
  | { kind: 'invalid'; notice: string };

/** Invalid manifests disable company features and never fall back to legacy. */
export function loadBoardSelection(workspace: string): BoardSelection {
  try {
    const project = loadProjectConfig(workspace);
    return project ? { kind: 'project', project } : { kind: 'legacy' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const notice = 'Ignoring company board: invalid .softwareagents/project.yaml: ' + detail;
    console.error('[Pixel Agents] ' + notice);
    return { kind: 'invalid', notice };
  }
}

/** Legacy adapter: a manifest without a binding never falls back to another board. */
export class BoardSources {
  constructor(
    private readonly workspace: string,
    readonly selection: BoardSelection,
  ) {}
  boardFile(): string | undefined {
    if (this.selection.kind === 'invalid') return undefined;
    if (this.selection.kind === 'legacy')
      return path.join(this.workspace, 'docs', 'backlog', 'board.json');
    const project = this.selection.project;
    const file = project.project.legacy?.boardFile;
    return file ? resolveInside(project.repoRoot, file) : undefined;
  }
  /** Revalidate optional source paths on every read. */
  source(root: string | undefined, file: string | undefined): string | undefined {
    if (this.selection.kind === 'invalid' || !root || !file) return undefined;
    if (this.selection.kind === 'legacy') return path.join(root, file);
    try {
      return resolveInside(root, file);
    } catch {
      return undefined;
    }
  }
}

import * as fs from 'fs';
import * as path from 'path';

import { companyWorkspaceRoot } from './companyControl.js';
import { PROJECT_SCOPE_TRANSCRIPT_READ_BYTES } from './constants.js';
import { loadProjectConfig } from './projectConfig.js';

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Read only session location metadata; never infer ownership from the transcript directory name. */
function transcriptCwd(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(PROJECT_SCOPE_TRANSCRIPT_READ_BYTES);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, length).toString('utf8').split('\n')) {
      try {
        const record = JSON.parse(line);
        const cwd =
          record.cwd ?? (record.type === 'session_meta' ? record.payload?.cwd : undefined);
        if (typeof cwd === 'string' && path.isAbsolute(cwd)) return cwd;
      } catch {
        /* incomplete or non-JSON record */
      }
    }
  } catch {
    /* missing transcript: ownership remains unknown */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return undefined;
}

/** Server-owned binding. A malformed binding fails closed, whereas no manifest preserves legacy behavior. */
export function sessionProject(
  cwd?: string,
  transcript?: string,
  workspace = companyWorkspaceRoot(),
): { allowed: boolean; projectId?: string } {
  if (!workspace) return { allowed: true };
  try {
    try {
      fs.lstatSync(path.join(workspace, '.softwareagents/project.yaml'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { allowed: true };
      throw error;
    }
    const config = loadProjectConfig(workspace);
    if (!config) return { allowed: true };
    const recordedCwd = transcript ? transcriptCwd(transcript) : undefined;
    const locations = [cwd, recordedCwd].filter((value): value is string => !!value);
    if (!locations.length || locations.some((location) => !path.isAbsolute(location)))
      return rejected();
    const canonical = locations.map((location) => fs.realpathSync.native(location));
    const roots = [config.repoRoot];
    // Registered worktrees may live outside the repository. Read Git's own
    // administrative records rather than trusting paths declared by the client.
    let gitDir = path.join(config.repoRoot, '.git');
    if (fs.existsSync(gitDir) && fs.statSync(gitDir).isFile()) {
      const pointer = fs.readFileSync(gitDir, 'utf8').trim();
      if (!pointer.startsWith('gitdir: ')) return rejected();
      gitDir = path.resolve(config.repoRoot, pointer.slice('gitdir: '.length));
      const common = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
      gitDir = path.resolve(gitDir, common);
      roots.push(fs.realpathSync.native(path.dirname(gitDir)));
    }
    const registered = path.join(gitDir, 'worktrees');
    if (fs.existsSync(registered)) {
      for (const entry of fs.readdirSync(registered)) {
        try {
          const pointer = fs.readFileSync(path.join(registered, entry, 'gitdir'), 'utf8').trim();
          roots.push(fs.realpathSync.native(path.dirname(pointer)));
        } catch {
          /* stale registration */
        }
      }
    }
    if (canonical.every((location) => roots.some((root) => inside(root, location))))
      return { allowed: true, projectId: config.project.id };
    return rejected();
  } catch {
    return rejected();
  }
}

function rejected(): { allowed: false } {
  console.warn(
    '[SoftwareAgents] Session not adopted: cwd outside bound Project or ownership unavailable',
  );
  return { allowed: false };
}

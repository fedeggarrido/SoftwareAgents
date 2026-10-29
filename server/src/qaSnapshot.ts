import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { EvalCriterionTerminationError, runVerifierCommand } from './evalCriteria.js';
import { EvalIntegrityError } from './evalIntegrity.js';
import { VerifierInfrastructureError } from './verifierInfrastructure.js';

/** Owned by one QA invocation. Never share snapshots across runs or retain a dirty tree. */
export class QaSnapshot {
  private directory?: string;
  private tree?: string;
  private sourceHash?: string;
  private snapshotHash?: string;
  private browserBuilt = false;
  private linked = false;
  private safe = true;
  readonly metrics = { copies: 0, builds: 0, reuses: 0, preparationMs: 0 };

  constructor(
    private readonly scratch: string,
    private readonly dependencies: string,
    private readonly pinnedSource = false,
  ) {}

  private excludedScratch(tree: string): string | undefined {
    const relative = path.relative(tree, this.scratch);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? path.join(tree, relative.split(path.sep)[0])
      : undefined;
  }

  private fingerprint(tree: string, snapshot = false): string {
    if (fs.lstatSync(tree).isSymbolicLink())
      throw new EvalIntegrityError('QA snapshot root is a link');
    const hash = createHash('sha256');
    const excluded = this.excludedScratch(tree);
    const visit = (directory: string) => {
      for (const name of fs.readdirSync(directory).sort()) {
        if (
          (name === '.git' && !snapshot) ||
          (name === 'node_modules' && (!snapshot || directory === tree))
        )
          continue;
        const file = path.join(directory, name);
        if (file === excluded) continue;
        const stat = fs.lstatSync(file);
        hash.update(JSON.stringify([path.relative(tree, file), stat.mode]));
        if (stat.isSymbolicLink()) throw new EvalIntegrityError('QA snapshot refuses source links');
        if (stat.isDirectory()) visit(file);
        else if (stat.isFile()) hash.update(fs.readFileSync(file));
        else throw new EvalIntegrityError('QA snapshot refuses non-regular files');
      }
    };
    visit(tree);
    return hash.digest('hex');
  }

  async prepare(source: string, browser: boolean, signal: AbortSignal, timeoutMs: number) {
    if (!this.safe)
      throw new EvalIntegrityError('QA snapshot retained after unconfirmed termination');
    const started = Date.now();
    const remaining = () => {
      const value = timeoutMs - (Date.now() - started);
      if (value <= 0 || signal.aborted)
        throw new VerifierInfrastructureError('QA snapshot preparation deadline exhausted');
      return value;
    };
    const sourceHash = this.fingerprint(source);
    if (this.pinnedSource && this.sourceHash && sourceHash !== this.sourceHash)
      throw new EvalIntegrityError('QA pinned baseline source changed');
    if (
      this.tree &&
      sourceHash === this.sourceHash &&
      this.fingerprint(this.tree, true) === this.snapshotHash
    ) {
      this.checkLink();
      this.metrics.reuses++;
    } else {
      this.dispose();
      this.directory = fs.mkdtempSync(path.join(this.scratch, 'qa-snapshot-'));
      this.tree = path.join(this.directory, 'project');
      fs.mkdirSync(this.tree);
      const excluded = this.excludedScratch(source);
      const hasBuild = fs.existsSync(path.join(source, 'esbuild.js'));
      for (const name of fs.readdirSync(source)) {
        const file = path.join(source, name);
        if (file === excluded) continue;
        fs.cpSync(file, path.join(this.tree, name), {
          recursive: true,
          filter: (entry) =>
            entry !== this.scratch &&
            !['.git', 'node_modules', ...(hasBuild ? ['dist'] : [])].includes(path.basename(entry)),
        });
      }
      fs.symlinkSync(
        this.dependencies,
        path.join(this.tree, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      this.linked = true;
      this.metrics.copies++;
      this.sourceHash = sourceHash;
      this.browserBuilt = false;
      if (hasBuild)
        await this.build([process.execPath, 'esbuild.js'], this.tree, signal, remaining());
    }
    if (browser && !this.browserBuilt) {
      await this.build(
        [process.execPath, path.join(this.dependencies, 'vite/bin/vite.js'), 'build'],
        path.join(this.tree!, 'webview-ui'),
        signal,
        remaining(),
      );
      this.browserBuilt = true;
    }
    this.snapshotHash = this.fingerprint(this.tree!, true);
    remaining();
    this.metrics.preparationMs += Date.now() - started;
    return this.tree!;
  }

  private async build(argv: string[], cwd: string, signal: AbortSignal, timeoutMs: number) {
    const home = path.join(this.directory!, 'home');
    fs.mkdirSync(home, { recursive: true });
    try {
      if ((await runVerifierCommand(argv, cwd, home, timeoutMs, signal)) !== 'pass')
        throw new VerifierInfrastructureError('QA snapshot build failed');
      this.metrics.builds++;
    } catch (error) {
      this.snapshotHash = undefined;
      if (error instanceof EvalCriterionTerminationError) this.safe = false;
      throw error;
    }
  }

  retain() {
    this.safe = false;
  }

  private checkLink() {
    const link = path.join(this.tree!, 'node_modules');
    if (
      fs.lstatSync(this.tree!).isSymbolicLink() ||
      !fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() ||
      fs.realpathSync.native(link) !== fs.realpathSync.native(this.dependencies)
    ) {
      this.safe = false;
      throw new EvalIntegrityError('QA snapshot dependency link changed; scratch retained');
    }
  }

  dispose() {
    if (!this.safe || !this.directory) return;
    if (this.linked) this.checkLink();
    // Remove links individually; recursive cleanup never follows dependency junctions.
    const remove = (file: string) => {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fs.unlinkSync(file);
      else if (stat.isDirectory()) {
        for (const name of fs.readdirSync(file)) remove(path.join(file, name));
        fs.rmdirSync(file);
      } else fs.unlinkSync(file);
    };
    remove(this.directory);
    this.directory = this.tree = this.sourceHash = this.snapshotHash = undefined;
    this.linked = false;
  }
}

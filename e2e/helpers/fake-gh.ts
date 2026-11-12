import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** A native executable is necessary on Windows because the runtime never uses a shell. */
export function installFakeGh(directory: string): string {
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    const source = path.join(directory, 'FakeGh.cs');
    fs.writeFileSync(
      source,
      `
using System;
class FakeGh {
  static int Main(string[] args) {
    if (args.Length == 0) return 1;
    if (args[0] == "auth") {
      if (Environment.GetEnvironmentVariable("SA_FAKE_GH_MODE") == "unauthenticated") {
        Console.Error.WriteLine("not logged in"); return 1;
      }
      return 0;
    }
    if (args[0] == "api") {
      Console.WriteLine(Array.IndexOf(args, "user/orgs") >= 0 ? "equipo-pruebas" : "operador-pruebas"); return 0;
    }
    if (args[0] == "repo") { Console.Error.WriteLine("name already exists"); return 1; }
    return 1;
  }
}
`,
    );
    const windows = process.env.WINDIR;
    if (!windows) throw new Error('WINDIR is required to compile the isolated gh fake');
    const compiler = path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    execFileSync(compiler, ['/nologo', '/target:exe', `/out:${path.join(bin, 'gh.exe')}`, source], {
      windowsHide: true,
    });
  } else {
    fs.writeFileSync(
      path.join(bin, 'gh'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'auth') {
  if (process.env.SA_FAKE_GH_MODE === 'unauthenticated') { console.error('not logged in'); process.exit(1); }
  process.exit(0);
}
if (args[0] === 'api') { console.log(args.includes('user/orgs') ? 'equipo-pruebas' : 'operador-pruebas'); process.exit(0); }
if (args[0] === 'repo') { console.error('name already exists'); process.exit(1); }
process.exit(1);
`,
      { mode: 0o700 },
    );
  }
  return bin;
}

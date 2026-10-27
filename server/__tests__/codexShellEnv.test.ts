import { describe, expect, it } from 'vitest';

import { windowsShellBaseline } from '../src/agentCompiler.js';

describe('windowsShellBaseline', () => {
  it('re-adds only non-secret Windows system variables, case-insensitively', () => {
    const baseline = windowsShellBaseline('win32', {
      systemroot: 'D:\\WIN',
      ComSpec: 'D:\\WIN\\system32\\cmd.exe',
      CLICKUP_TOKEN: 'secret',
      OPENAI_API_KEY: 'secret',
    });
    expect(baseline).toEqual([
      ['SystemRoot', 'D:\\WIN'],
      ['WINDIR', 'D:\\WIN'],
      ['ComSpec', 'D:\\WIN\\system32\\cmd.exe'],
      ['PATHEXT', '.COM;.EXE;.BAT;.CMD'],
    ]);
    expect(JSON.stringify(baseline)).not.toContain('secret');
  });

  it('adds nothing outside Windows', () => {
    expect(windowsShellBaseline('linux', { SystemRoot: 'x' })).toEqual([]);
  });
});

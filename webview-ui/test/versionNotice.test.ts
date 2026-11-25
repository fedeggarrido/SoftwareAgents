import { describe, expect, it } from 'vitest';

import { versionNotice } from '../src/components/versionNotice.js';

describe('version notice', () => {
  it('records a fresh profile without announcing an update', () => {
    expect(versionNotice('1.4.1', '')).toEqual({ showUpdate: false, recordCurrent: true });
  });
  it('waits for settings before recording a version', () => {
    expect(versionNotice('', '')).toEqual({ showUpdate: false, recordCurrent: false });
  });
  it('announces a new minor version for a returning profile', () => {
    expect(versionNotice('1.4.1', '1.3')).toEqual({ showUpdate: true, recordCurrent: false });
  });
  it('does not announce the recorded minor version again', () => {
    expect(versionNotice('1.4.2', '1.4')).toEqual({ showUpdate: false, recordCurrent: false });
  });
});

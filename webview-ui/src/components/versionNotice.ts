import { toMajorMinor } from '../changelogData.js';

export function versionNotice(currentVersion: string, lastSeenVersion: string) {
  const current = toMajorMinor(currentVersion);
  return {
    showUpdate: Boolean(currentVersion && lastSeenVersion && current !== lastSeenVersion),
    recordCurrent: Boolean(currentVersion && !lastSeenVersion),
  };
}

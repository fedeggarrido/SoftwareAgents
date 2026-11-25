import { useCallback, useEffect, useState } from 'react';

/** Classify the profile once settings arrive. VersionIndicator records the visit; the server reads
 *  hooksInfoShown as a dismissed consent ask, so the guide must never write it. */
export function useProjectGuide(
  currentVersion: string,
  lastSeenVersion: string,
  hooksInfoShown: boolean,
) {
  const [state, setState] = useState<'waiting' | 'open' | 'closed'>('waiting');
  useEffect(() => {
    if (state !== 'waiting' || !currentVersion) return;
    const firstVisit = !lastSeenVersion && !hooksInfoShown;
    setState(firstVisit ? 'open' : 'closed');
  }, [state, currentVersion, lastSeenVersion, hooksInfoShown]);
  const onClose = useCallback(() => setState('closed'), []);
  return { open: state === 'open', onClose };
}

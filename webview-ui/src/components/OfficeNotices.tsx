import type { ReactNode } from 'react';

import { OfficeModeIndicator } from './OfficeModeIndicator.js';

/** Keep access help and dismissible notices in normal flow at every viewport width. */
export function OfficeNotices({ children }: { children?: ReactNode }) {
  return (
    <div className="office-notices absolute top-10 right-10 layer-notices flex flex-col items-end gap-8 max-w-[calc(100vw-20px)]">
      <OfficeModeIndicator />
      {children}
    </div>
  );
}

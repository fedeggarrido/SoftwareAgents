import type { ReactNode } from 'react';
import { useId } from 'react';

interface MenuItemProps {
  onClick: () => void;
  children: ReactNode;
  right?: ReactNode;
  help?: string;
  className?: string;
}

export function MenuItem({ onClick, children, right, help, className = '' }: MenuItemProps) {
  const helpId = useId();
  return (
    <button
      onClick={onClick}
      aria-labelledby={help ? `${helpId}-label` : undefined}
      aria-describedby={help ? helpId : undefined}
      className={`flex items-center justify-between w-full py-6 px-10 bg-transparent border-none rounded-none cursor-pointer text-left hover:bg-btn-bg ${className}`}
    >
      <span>
        <span id={help ? `${helpId}-label` : undefined}>{children}</span>
        {help && (
          <span id={helpId} className="setting-help">
            {help}
          </span>
        )}
      </span>
      {right}
    </button>
  );
}

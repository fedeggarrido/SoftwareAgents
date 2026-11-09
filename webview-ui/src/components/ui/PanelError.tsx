import { OfficeRecoveryActions } from '../OfficeRecoveryActions.js';
import { Button } from './Button.js';

export function PanelError({
  cause,
  onRetry,
  disabled = false,
}: {
  cause: string;
  onRetry: () => void;
  disabled?: boolean;
}) {
  return (
    <div role="alert" className="panel-error">
      <span aria-hidden="true">⚠</span>
      <p>{cause}</p>
      <Button size="sm" onClick={onRetry} disabled={disabled}>
        Reintentar
      </Button>
      <OfficeRecoveryActions />
    </div>
  );
}

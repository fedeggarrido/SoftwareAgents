import { OFFICE_ACCESS_INSTRUCTIONS } from '../../../core/src/officeAccess.js';
import { useOfficeRecovery } from '../office/recoveryActions.js';
import { Button } from './ui/Button.js';

export function OfficeRecoveryActions({ project = false }: { project?: boolean }) {
  const recovery = useOfficeRecovery();
  return (
    <div className="flex flex-wrap gap-8">
      {project && (
        <Button size="sm" onClick={recovery.prepareProject}>
          Preparar proyecto
        </Button>
      )}
      <Button size="sm" onClick={recovery.openSettings}>
        Abrir Ajustes
      </Button>
    </div>
  );
}

/** A read-only connection asked for operator-only data: say whose it is and how to get access. */
export function OperatorOnlyNotice({ message }: { message: string }) {
  return (
    <div>
      <p role="status">
        {message} {OFFICE_ACCESS_INSTRUCTIONS}
      </p>
      <OfficeRecoveryActions />
    </div>
  );
}

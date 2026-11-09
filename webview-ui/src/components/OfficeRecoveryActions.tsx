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
        Abrir Settings
      </Button>
    </div>
  );
}

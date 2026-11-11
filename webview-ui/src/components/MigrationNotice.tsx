import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface MigrationNoticeProps {
  onDismiss: () => void;
}

export function MigrationNotice({ onDismiss }: MigrationNoticeProps) {
  return (
    <Modal
      isOpen
      onClose={onDismiss}
      title="La distribución se ha restablecido"
      className="migration-dialog"
    >
      <div className="p-12 flex flex-col gap-12">
        <p>
          La oficina usa ahora recursos gráficos de código abierto. Este cambio ha restablecido la
          distribución anterior.
        </p>
        <p>Puedes reorganizar los muebles desde el editor de la oficina.</p>
        <Button variant="primary" onClick={onDismiss}>
          Entendido
        </Button>
      </div>
    </Modal>
  );
}

import { es } from '../i18n/es.js';
import type { InboxAction, InboxEntry } from '../office/ownerInbox.js';
import { Button } from './ui/Button.js';

interface InboxPanelProps {
  entries: readonly InboxEntry[];
  onAct: (action: InboxAction) => void;
  /** Answered decisions and their history stay one click away. */
  onOpenDecisions: () => void;
}

/** SA-132: one place for everything that waits for the owner, most urgent first. */
export function InboxPanel({ entries, onAct, onOpenDecisions }: InboxPanelProps) {
  const copy = es.inbox;
  return (
    <section
      className="read-only-panel inbox-panel p-10 flex flex-col gap-8"
      data-testid="inbox-panel"
      role="region"
      aria-label={copy.title}
    >
      {entries.length === 0 ? (
        <div role="status">
          <p>{copy.empty}</p>
          <p className="text-text-muted">{copy.covers}</p>
        </div>
      ) : (
        <ol className="inbox-list">
          {entries.map((entry) => (
            <li key={entry.id} className="inbox-entry" data-testid="inbox-entry">
              <span className="inbox-kind">{entry.kindLabel}</span>
              <p>{entry.title}</p>
              {entry.detail && <p className="text-text-muted">{entry.detail}</p>}
              {entry.action.kind !== 'none' && (
                <Button size="sm" variant="secondary" onClick={() => onAct(entry.action)}>
                  {copy.actions[entry.action.kind]}
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
      <Button size="sm" variant="ghost" onClick={onOpenDecisions}>
        {copy.allDecisions}
      </Button>
    </section>
  );
}

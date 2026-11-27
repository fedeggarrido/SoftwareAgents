import { useEffect, useState } from 'react';

import { es } from '../i18n/es.js';
import { officeAccessView, useOfficeAccess } from '../office/accessStore.js';
import { isBrowserRuntime } from '../runtime.js';
import { Button } from './ui/Button.js';

/** Pausing preserves the step without owning focus or Escape. */
export function ProjectGuide({
  visible,
  onClose,
  onNewIdea,
}: {
  visible: boolean;
  onClose: () => void;
  onNewIdea: () => void;
}) {
  const [step, setStep] = useState(0);
  const [glossary, setGlossary] = useState(false);
  const access = officeAccessView(useOfficeAccess(), !isBrowserRuntime);
  const steps = es.projectGuide.workflow;
  const last = step === steps.length - 1;
  useEffect(() => {
    if (!visible) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [visible, onClose]);
  return (
    <section
      className="intro-guide pixel-panel"
      aria-label={es.projectGuide.guide}
      hidden={!visible}
    >
      <header>
        <h2 aria-live="polite">{glossary ? es.projectGuide.glossary : steps[step].title}</h2>
        <Button variant="ghost" size="icon" aria-label={es.projectGuide.close} onClick={onClose}>
          ✕
        </Button>
      </header>
      {glossary ? (
        <dl className="guide-glossary">
          {es.projectGuide.terms.map((entry) => (
            <div key={entry.term}>
              <dt>{entry.term}</dt>
              <dd>{entry.definition}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div aria-live="polite">
          <p>{es.projectGuide.step(step + 1, steps.length)}</p>
          <p>{steps[step].description}</p>
          {last && (access.blocked || access.pending) && (
            <p>
              {access.explanation} {access.details}
            </p>
          )}
        </div>
      )}
      <footer>
        <Button variant="ghost" aria-pressed={glossary} onClick={() => setGlossary(!glossary)}>
          {glossary ? es.projectGuide.backToGuide : es.projectGuide.glossary}
        </Button>
        {!glossary && step > 0 && (
          <Button variant="ghost" onClick={() => setStep(step - 1)}>
            {es.projectGuide.back}
          </Button>
        )}
        {glossary ? null : last ? (
          access.blocked || access.pending ? (
            <Button onClick={onClose}>{es.projectGuide.finish}</Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => {
                onClose();
                onNewIdea();
              }}
            >
              {es.officeWelcome.newIdea}
            </Button>
          )
        ) : (
          <Button onClick={() => setStep(step + 1)}>{es.projectGuide.next}</Button>
        )}
      </footer>
    </section>
  );
}

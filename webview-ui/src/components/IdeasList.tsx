import type { IdeaSummary, ProjectSummaryItem } from '../../../core/src/messages.js';
import { es } from '../i18n/es.js';
import { IdeaCommand } from './IdeaCommand.js';

export function IdeasList({
  ideas,
  checkoutName,
  goals,
  loading = false,
}: {
  ideas: IdeaSummary[];
  checkoutName?: string;
  goals?: ProjectSummaryItem[];
  loading?: boolean;
}) {
  if (!ideas.length) return null;
  return (
    <section aria-label="Ideas pendientes" className="flex flex-col gap-8">
      <h3 title={es.vocabulary.pendingIdeasHelp}>{es.vocabulary.pendingIdeas}</h3>
      {ideas.map((idea) => {
        const text = goals?.find((goal) => goal.key === idea.key)?.text;
        return (
          <article
            key={idea.key}
            className="idea-row bg-bg-dark border-2 border-border p-8"
            data-state="idea_pending"
          >
            <h4 className="text-accent-bright">{idea.key}</h4>
            <p className="idea-text">
              {text ?? (loading ? es.features.ideaLoading : es.features.ideaUnavailable)}
            </p>
            {text && (
              <details className="idea-description">
                <summary>{es.features.readIdea}</summary>
                <p>{text}</p>
              </details>
            )}
            <span className="feature-state-chip">Idea · pendiente</span>
            <p>Sin iniciar. Guardar no inicia ningún trabajo.</p>
            <IdeaCommand key={idea.command} command={idea.command} checkoutName={checkoutName} />
          </article>
        );
      })}
    </section>
  );
}

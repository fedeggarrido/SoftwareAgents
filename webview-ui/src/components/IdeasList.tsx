import type { IdeaSummary } from '../../../core/src/messages.js';
import { IdeaCommand } from './IdeaCommand.js';

export function IdeasList({
  ideas,
  checkoutName,
}: {
  ideas: IdeaSummary[];
  checkoutName?: string;
}) {
  if (!ideas.length) return null;
  return (
    <section aria-label="Ideas pendientes" className="flex flex-col gap-8">
      <h3>Ideas pendientes · sin FeatureSpec</h3>
      {ideas.map((idea) => (
        <article
          key={idea.key}
          className="idea-row bg-bg-dark border-2 border-border p-8 text-xs"
          data-state="idea_pending"
        >
          <h4 className="text-accent-bright">{idea.key}</h4>
          <span className="feature-state-chip">Idea · pendiente</span>
          <p>Sin iniciar. Guardar no inicia ningún trabajo.</p>
          <IdeaCommand key={idea.command} command={idea.command} checkoutName={checkoutName} />
        </article>
      ))}
    </section>
  );
}

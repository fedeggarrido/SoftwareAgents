import { validGithubName } from '../../../core/src/githubHosting.js';
import type {
  GithubHostingError,
  GithubHostingOptions,
  GithubHostingResult,
  GithubVisibility,
} from '../../../core/src/messages.js';

export interface GithubDraft {
  owner: string;
  name: string;
  visibility: GithubVisibility;
}
export interface GithubWizardState {
  step:
    | 'idle'
    | 'loading'
    | 'configure'
    | 'confirm'
    | 'publishing'
    | 'failed'
    | 'uncertain'
    | 'published';
  options: GithubHostingOptions | null;
  draft: GithubDraft;
  pending: string | null;
  error: GithubHostingError | null;
}
export const initialGithubWizard = (): GithubWizardState => ({
  step: 'idle',
  options: null,
  draft: { owner: '', name: '', visibility: 'private' },
  pending: null,
  error: null,
});
export type GithubWizardEvent =
  | { type: 'load' | 'publish'; requestId: string }
  | { type: 'edit'; draft: Partial<GithubDraft> }
  | { type: 'review' | 'back' | 'lost' }
  | { type: 'reply'; message: GithubHostingOptions | GithubHostingResult };

export function githubWizardReducer(
  state: GithubWizardState,
  event: GithubWizardEvent,
): GithubWizardState {
  switch (event.type) {
    case 'load':
      return state.pending
        ? state
        : { ...state, step: 'loading', pending: event.requestId, options: null, error: null };
    case 'publish':
      return state.step !== 'confirm' || !state.options?.confirmationId || state.pending
        ? state
        : { ...state, step: 'publishing', pending: event.requestId, error: null };
    case 'reply': {
      if (event.message.requestId !== state.pending) return state;
      const message = event.message;
      if (message.type === 'githubHostingResult')
        return {
          ...state,
          pending: null,
          options: null,
          error: message.errorCode,
          step: message.status === 'published' ? 'published' : 'failed',
        };
      if (message.errorCode || !message.confirmationId || !message.login)
        return {
          ...state,
          step: 'failed',
          pending: null,
          options: null,
          error: message.errorCode ?? 'unavailable',
        };
      return {
        ...state,
        step: 'configure',
        options: message,
        pending: null,
        error: null,
        draft:
          message.operation === 'push'
            ? { owner: message.owner, name: message.name, visibility: message.visibility }
            : {
                owner: message.owners.includes(state.draft.owner)
                  ? state.draft.owner
                  : message.owner,
                name: state.draft.name || message.name,
                visibility: state.draft.visibility,
              },
      };
    }
    case 'edit':
      return state.step === 'configure' && state.options?.operation !== 'push'
        ? { ...state, draft: { ...state.draft, ...event.draft } }
        : state;
    case 'review':
      return state.step === 'configure' &&
        validGithubName(state.draft.name) &&
        state.options?.owners.includes(state.draft.owner)
        ? { ...state, step: 'confirm' }
        : state;
    case 'back':
      return state.step === 'confirm' ? { ...state, step: 'configure' } : state;
    case 'lost':
      return state.pending
        ? {
            ...state,
            step: state.step === 'publishing' ? 'uncertain' : 'failed',
            pending: null,
            options: null,
            error: 'unavailable',
          }
        : state;
  }
}

import type {
  NewProjectError,
  NewProjectOptions,
  NewProjectResult,
  NewProjectValidation,
  ProjectDirectories,
  ProjectFolderMode,
  ProjectHosting,
} from '../../../core/src/messages.js';
import {
  projectSlug,
  validProjectName,
  validProjectSlug,
} from '../../../core/src/projectNaming.js';

export type WizardStep =
  'loading' | 'name' | 'path' | 'hosting' | 'confirm' | 'creating' | 'created' | 'uncertain';
export interface ProjectDraft {
  name: string;
  parentPath: string;
  folderMode: ProjectFolderMode;
  hosting: ProjectHosting;
}
export type WizardOperation = 'options' | 'browse' | 'save_default' | 'validate' | 'create';
const operationSteps: Record<WizardOperation, WizardStep[]> = {
  options: ['loading', 'name'],
  browse: ['path'],
  save_default: ['path'],
  validate: ['path'],
  create: ['confirm'],
};
export interface NewProjectWizardState {
  step: WizardStep;
  draft: ProjectDraft;
  proposals: string[];
  directories: ProjectDirectories | null;
  validation: NewProjectValidation | null;
  result: NewProjectResult | null;
  pending: { requestId: string; operation: WizardOperation } | null;
  error: NewProjectError | null;
  defaultSaved: string | null;
}
export const initialProjectWizard = (): NewProjectWizardState => ({
  step: 'loading',
  draft: { name: '', parentPath: '', folderMode: 'create', hosting: 'local' },
  proposals: [],
  directories: null,
  validation: null,
  result: null,
  pending: null,
  error: null,
  defaultSaved: null,
});

export type WizardEvent =
  | { type: 'edit'; draft: Partial<ProjectDraft> }
  | { type: 'next' | 'back' | 'lost' }
  | { type: 'begin'; requestId: string; operation: WizardOperation }
  | {
      type: 'reply';
      message: NewProjectOptions | ProjectDirectories | NewProjectValidation | NewProjectResult;
    };

export function canContinueProjectName(name: string): boolean {
  return validProjectName(name) && validProjectSlug(projectSlug(name));
}

/** Only the path validation reply may advance from path to hosting. */
export function projectWizardReducer(
  state: NewProjectWizardState,
  event: WizardEvent,
): NewProjectWizardState {
  if (event.type === 'lost') {
    if (!state.pending) return state;
    return {
      ...state,
      pending: null,
      step:
        state.pending?.operation === 'create'
          ? 'uncertain'
          : state.step === 'loading'
            ? 'name'
            : state.step,
      error: 'unavailable',
    };
  }
  if (event.type === 'reply') {
    if (state.pending?.requestId !== event.message.requestId) return state;
    const { message } = event;
    const next = { ...state, pending: null, error: message.errorCode };
    switch (message.type) {
      case 'newProjectOptions':
        return {
          ...next,
          step: 'name',
          proposals: message.proposals,
          draft: {
            ...state.draft,
            name: state.draft.name || message.proposals[0] || '',
            parentPath: message.defaultParent ?? '',
          },
        };
      case 'projectDirectories':
        return message.errorCode
          ? next
          : {
              ...next,
              directories: message,
              draft: {
                ...state.draft,
                parentPath: message.path ?? state.draft.parentPath,
                folderMode: 'create',
              },
              validation: null,
              defaultSaved:
                state.pending.operation === 'save_default' ? message.path : state.defaultSaved,
            };
      case 'newProjectValidation':
        return {
          ...next,
          validation: message,
          step: message.status === 'ready' ? 'hosting' : 'path',
        };
      case 'newProjectResult':
        return {
          ...next,
          result: message,
          step: message.status === 'created' ? 'created' : 'path',
          validation:
            message.status === 'created'
              ? state.validation
              : { ...message, type: 'newProjectValidation', status: 'rejected' },
        };
    }
  }
  if (state.pending || ['creating', 'created', 'uncertain'].includes(state.step)) return state;
  switch (event.type) {
    case 'edit':
      return {
        ...state,
        draft: { ...state.draft, ...event.draft },
        error: null,
        validation: event.draft.hosting ? state.validation : null,
        defaultSaved: null,
      };
    case 'begin':
      if (
        !operationSteps[event.operation].includes(state.step) ||
        (event.operation === 'create' && state.validation?.status !== 'ready')
      )
        return state;
      return {
        ...state,
        pending: { requestId: event.requestId, operation: event.operation },
        step: event.operation === 'create' ? 'creating' : state.step,
        error: null,
      };
    case 'next':
      if (state.step === 'name' && canContinueProjectName(state.draft.name))
        return { ...state, step: 'path' };
      if (state.step === 'hosting' && state.validation?.status === 'ready')
        return { ...state, step: 'confirm' };
      return state;
    case 'back':
      return {
        ...state,
        error: null,
        step: state.step === 'confirm' ? 'hosting' : state.step === 'hosting' ? 'path' : 'name',
      };
  }
}

import type { ReactElement } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IDEA_ASSUMPTION_TEXT, IDEA_QUESTIONS } from '../../core/src/ideaInterview.js';
import type { IdeasSnapshot, SubmitIdeaResult } from '../../core/src/messages.js';
import { IDEA_REQUEST_TIMEOUT_MS } from '../src/constants.js';
import { setOfficeAccess } from '../src/office/accessStore.js';
import {
  applyIdeaResult,
  applyIdeasSnapshot,
  emptyIdeasStore,
  getIdeasStore,
  receiveProjectPreparationResult,
  setIdeasStore,
} from '../src/office/ideasStore.js';

// Node-only hook harness. Execute dependency changes and cleanups, including real timers.
// Runtime component paths keep TSX outside tsconfig.node.
const lifecycle = vi.hoisted(() => ({
  state: 'connected',
  states: [] as unknown[],
  stateCursor: 0,
  send: vi.fn(),
  close: vi.fn(),
  cursor: 0,
  effects: [] as Array<{ dependencies?: readonly unknown[]; cleanup?: () => void }>,
  scheduled: [] as Array<() => void>,
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useSyncExternalStore: (_: unknown, get: () => unknown) => get(),
  useState: (initial: unknown) => {
    const index = lifecycle.stateCursor++;
    if (index >= lifecycle.states.length)
      lifecycle.states[index] = typeof initial === 'function' ? initial() : initial;
    return [
      lifecycle.states[index],
      (value: unknown) => {
        lifecycle.states[index] =
          typeof value === 'function' ? value(lifecycle.states[index]) : value;
      },
    ];
  },
  useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
    const index = lifecycle.cursor++;
    const previous = lifecycle.effects[index];
    if (
      previous &&
      dependencies &&
      previous.dependencies &&
      dependencies.length === previous.dependencies.length &&
      dependencies.every((value, i) => Object.is(value, previous.dependencies![i]))
    )
      return;
    lifecycle.scheduled.push(() => {
      previous?.cleanup?.();
      lifecycle.effects[index] = { dependencies, cleanup: effect() || undefined };
    });
  },
}));
vi.mock('../src/transport/index.js', () => ({
  transport: {
    get state() {
      return lifecycle.state;
    },
    onStateChange: () => () => {},
    send: lifecycle.send,
  },
}));
const dialogPath = '../src/components/NewIdeaDialog.js';
const listPath = '../src/components/IdeasList.js';
const transportPath = '../src/transport/index.js';
const snapshot: IdeasSnapshot = {
  type: 'ideasSnapshot',
  requestId: 'r',
  projectId: 'P',
  canSubmit: true,
  errorCode: null,
  ideas: [],
};
const result: SubmitIdeaResult = {
  type: 'submitIdeaResult',
  requestId: 's',
  projectId: 'P',
  status: 'saved',
  errorCode: null,
  idea: {
    key: 'FEAT-001',
    command:
      'pixel-agents feature run FEAT-001 --request .softwareagents/ideas/P/FEAT-001.md --confirm',
  },
};
async function tree(): Promise<ReactElement> {
  const { NewIdeaDialog } = await import(dialogPath);
  lifecycle.cursor = 0;
  lifecycle.stateCursor = 0;
  return NewIdeaDialog({ onClose: lifecycle.close });
}
async function render() {
  let node = await tree();
  // Effects update the store. Render again to install the matching deadlines.
  while (lifecycle.scheduled.length) {
    const effects = lifecycle.scheduled.splice(0);
    for (const effect of effects) effect();
    node = await tree();
  }
  return renderToStaticMarkup(node);
}
function findAction(node: unknown, text: string): (() => void) | undefined {
  if (Array.isArray(node)) return node.map((child) => findAction(child, text)).find(Boolean);
  if (!node || typeof node !== 'object') return;
  const props = (node as ReactElement<{ children?: unknown; onClick?: () => void }>).props;
  if (props?.children === text && props.onClick) return props.onClick;
  return findAction(props?.children, text);
}
function respond(over: Partial<IdeasSnapshot> = {}) {
  setIdeasStore(
    applyIdeasSnapshot(getIdeasStore(), {
      ...snapshot,
      requestId: getIdeasStore().requestId!,
      ...over,
    }),
  );
}
interface InteractiveProps {
  children?: unknown;
  id?: string;
  value?: unknown;
  disabled?: boolean;
  onClick?: () => void;
  onClose?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
}
function findControl(
  node: unknown,
  match: (props: InteractiveProps) => boolean,
): InteractiveProps | undefined {
  if (Array.isArray(node)) return node.map((child) => findControl(child, match)).find(Boolean);
  if (!node || typeof node !== 'object') return;
  const props = (node as ReactElement<InteractiveProps>).props;
  if (!props) return;
  if (match(props)) return props;
  return findControl(props.children, match);
}
async function click(label: string) {
  const control = findControl(
    await tree(),
    (props) => props.children === label && !!props.onClick,
  )!;
  expect(control.disabled).not.toBe(true);
  control.onClick!();
  return render();
}
async function change(id: string, value: string) {
  const control = findControl(await tree(), (props) => props.id === id)!;
  expect(control.disabled).not.toBe(true);
  control.onChange!({ target: { value } });
  return render();
}
async function choose(choice: 'answer' | 'decide') {
  findControl(await tree(), (props) => props.value === choice && !!props.onChange)!.onChange!({
    target: { value: choice },
  });
  return render();
}
async function review() {
  await change('new-idea-text', 'Una idea literal');
  await click('Siguiente');
  for (const question of IDEA_QUESTIONS) {
    await change('idea-answer', 'Respuesta ' + question.id);
    await click('Siguiente');
  }
}
async function submit() {
  await review();
  await click('Guardar idea');
}
beforeEach(() => {
  setOfficeAccess({ type: 'officeAccess', privileged: true, reason: null });
  vi.useFakeTimers();
  lifecycle.state = 'connected';
  lifecycle.states = [];
  lifecycle.stateCursor = 0;
  lifecycle.cursor = 0;
  lifecycle.effects = [];
  lifecycle.scheduled = [];
  lifecycle.send.mockReset();
  lifecycle.close.mockReset();
  setIdeasStore(emptyIdeasStore());
});
afterEach(() => {
  for (const effect of lifecycle.effects) effect.cleanup?.();
  vi.useRealTimers();
});

describe('SA-109/110 dialog lifecycle and presentation', () => {
  it.each([
    ['offline', 'reconnecting', false],
    ['pending', 'connected', true],
    ['loading', 'connected', false],
    ['offline and pending', 'reconnecting', true],
  ] as const)(
    'allows drafting and navigation while %s, gating only submission',
    async (_, connection, pending) => {
      lifecycle.state = connection;
      if (pending) setOfficeAccess(null);
      const html = await render();
      expect(html).not.toMatch(/<textarea[^>]*disabled/);
      if (connection === 'reconnecting' && pending) {
        expect(html).toContain('Sin conexión con la oficina: el programa pixel-agents');
        expect(html).toContain('Reintentando conexión con la oficina');
        expect(html).not.toContain('Esperando a que confirme');
      }
      await review();
      const save = findControl(await tree(), (props) => props.children === 'Guardar idea')!;
      expect(save.disabled).toBe(true);
      save.onClick!();
      expect(
        lifecycle.send.mock.calls.filter(([message]) => message.type === 'submitIdea'),
      ).toHaveLength(0);
      await click('Anterior');
      expect(await render()).toContain('Respuesta ' + IDEA_QUESTIONS.at(-1)!.id);
      await click('Siguiente');
      lifecycle.state = 'connected';
      await render();
      respond();
      await render();
      expect(
        findControl(await tree(), (props) => props.children === 'Guardar idea')!.disabled,
      ).toBe(pending);
      setOfficeAccess({ type: 'officeAccess', privileged: true, reason: null });
      await render();
      expect(
        findControl(await tree(), (props) => props.children === 'Guardar idea')!.disabled,
      ).toBe(false);
      expect(await render()).toContain('Una idea literal');
    },
  );

  it('retains the interview and answers through disconnect until a new access handshake', async () => {
    await render();
    respond();
    await render();
    await change('new-idea-text', 'Borrador que debe sobrevivir');
    await click('Siguiente');
    await change('idea-answer', 'Respuesta que debe sobrevivir');
    lifecycle.state = 'reconnecting';
    setOfficeAccess(null);
    let html = await render();
    expect(html).toContain('Respuesta que debe sobrevivir');
    expect(html).toContain('<textarea');
    expect(html).not.toContain('URL con token');
    expect(html).not.toContain('Solo lectura');
    expect(findAction(await tree(), 'Siguiente')).toBeDefined();
    expect(findControl(await tree(), (props) => props.id === 'idea-answer')!.disabled).toBe(false);
    lifecycle.state = 'connected';
    await render();
    respond();
    html = await render();
    expect(html).toContain('Respuesta que debe sobrevivir');
    expect(html).not.toContain('URL con token');
    expect(findControl(await tree(), (props) => props.id === 'idea-answer')!.disabled).toBe(false);
    setOfficeAccess({ type: 'officeAccess', privileged: false, reason: 'token_required' });
    html = await render();
    expect(html).toContain('URL con token');
    expect(html).not.toContain('<textarea');
    setOfficeAccess({ type: 'officeAccess', privileged: true, reason: null });
    html = await render();
    expect(html).toContain('Respuesta que debe sobrevivir');
    expect(findControl(await tree(), (props) => props.id === 'idea-answer')!.disabled).toBe(false);
  });

  it.each([
    [false, 'token_required', 'inicia pixel-agents tú mismo en tu terminal'],
    [true, 'managed_process', 'Esta oficina se inició desde un agente'],
  ] as const)(
    'SA-116 explains restricted access before the interview (%s, %s)',
    async (privileged, reason, explanation) => {
      setOfficeAccess({ type: 'officeAccess', privileged, reason });
      // Even a writable snapshot cannot override the server's access restriction.
      await render();
      respond();
      const html = await render();
      expect(html).toContain(explanation);
      expect(html).not.toContain('<textarea');
      expect(html).not.toContain('Siguiente');
      expect(html).not.toContain('Preparar proyecto');
      expect(html).not.toContain('Reintentar');
      expect(html).not.toContain('role="alert"');
      expect(findAction(await tree(), 'Guardar idea')).toBeUndefined();
      await click('Cerrar');
      expect(lifecycle.close).toHaveBeenCalledOnce();
    },
  );

  it('preserves the edited project name across reads and reconnects until the Project changes', async () => {
    await render();
    const preparation = {
      id: 'project-1',
      name: 'Detected name',
      defaultBranch: 'main',
      remote: 'local',
      configPath: '.softwareagents/project.yaml',
      brainPath: '.softwareagents/brain',
    };
    const unprepared = {
      projectId: null,
      canSubmit: false,
      errorCode: 'missing_manifest' as const,
    };
    respond({ ...unprepared, preparation });
    await render();
    await change('project-name', 'Edited name');
    await click('Reintentar lectura de ideas');
    await render();
    respond({ ...unprepared, preparation: { ...preparation, name: 'New detection' } });
    await render();
    expect(findControl(await tree(), (props) => props.id === 'project-name')?.value).toBe(
      'Edited name',
    );
    lifecycle.state = 'reconnecting';
    await render();
    lifecycle.state = 'connected';
    await render();
    respond({ ...unprepared, preparation });
    await render();
    expect(findControl(await tree(), (props) => props.id === 'project-name')?.value).toBe(
      'Edited name',
    );
    await click('Reintentar lectura de ideas');
    await render();
    respond({
      ...unprepared,
      preparation: { ...preparation, id: 'project-2', name: 'Other project' },
    });
    await render();
    expect(findControl(await tree(), (props) => props.id === 'project-name')?.value).toBe(
      'Other project',
    );
  });

  it('prepares an unprepared project and continues with the typed idea in the same dialog', async () => {
    const { transport } = await import(transportPath);
    await render();
    respond({
      projectId: null,
      canSubmit: false,
      errorCode: 'missing_manifest',
      preparation: {
        id: 'mi-proyecto-123',
        name: 'Mi proyecto',
        defaultBranch: 'trunk',
        remote: 'local',
        configPath: '.softwareagents/project.yaml',
        brainPath: '.softwareagents/brain',
      },
    });
    const html = await render();
    expect(html).toContain('Nombre del proyecto');
    expect(html).toContain('Mi proyecto');
    expect(html).toContain('trunk');
    expect(html).toContain('.softwareagents/project.yaml');
    expect(html).toContain('commit tú mismo');
    await change('new-idea-text', 'Idea que se conserva');
    await change('project-name', 'Nombre humano');
    await click('Preparar proyecto');
    expect(lifecycle.send).toHaveBeenLastCalledWith({
      type: 'prepareProject',
      requestId: getIdeasStore().preparationPending,
      name: 'Nombre humano',
    });
    expect(findControl(await tree(), (props) => props.children === 'Preparando…')?.disabled).toBe(
      true,
    );
    receiveProjectPreparationResult(
      {
        type: 'prepareProjectResult',
        requestId: getIdeasStore().preparationPending!,
        projectId: 'mi-proyecto-123',
        status: 'created',
        errorCode: null,
      },
      transport,
    );
    expect(lifecycle.send).toHaveBeenLastCalledWith({
      type: 'requestIdeas',
      requestId: getIdeasStore().requestId,
    });
    respond({ projectId: 'mi-proyecto-123' });
    const ready = await render();
    expect(ready).toContain('Idea que se conserva');
    expect(ready).toContain('Proyecto preparado');
    expect(ready).not.toContain('id="project-name"');
    await click('Siguiente');
    expect(await render()).toContain(IDEA_QUESTIONS[0].helper);
    expect(lifecycle.close).not.toHaveBeenCalled();
    expect(
      lifecycle.send.mock.calls.filter(([message]) => message.type === 'submitIdea'),
    ).toHaveLength(0);
  });

  it('explains read-only preparation and refuses unsupported adapters without a creation form', async () => {
    await render();
    respond({ projectId: null, canSubmit: false, errorCode: 'denied' });
    expect(await render()).toContain('inicia pixel-agents tú mismo en tu terminal');
    expect(await render()).not.toContain('<textarea');
    expect(await render()).not.toContain('Reintentar lectura de ideas');
    expect(await render()).not.toContain('role="alert"');
    expect(await render()).not.toContain('id="project-name"');
    respond({ projectId: null, canSubmit: false, errorCode: 'unsupported_adapter' });
    expect(await render()).toContain('VS Code');
    expect(await render()).not.toContain('id="project-name"');
  });

  it('reads after a lost preparation answer and ignores late results without replaying creation', async () => {
    const { transport } = await import(transportPath);
    await render();
    respond({
      projectId: null,
      canSubmit: false,
      errorCode: 'missing_manifest',
      preparation: {
        id: 'project-1',
        name: 'Project',
        defaultBranch: 'main',
        remote: 'local',
        configPath: '.softwareagents/project.yaml',
        brainPath: '.softwareagents/brain',
      },
    });
    await render();
    await change('new-idea-text', 'Texto antes del timeout');
    await click('Preparar proyecto');
    const pending = getIdeasStore().preparationPending!;
    await vi.advanceTimersByTimeAsync(IDEA_REQUEST_TIMEOUT_MS);
    await render();
    expect(
      lifecycle.send.mock.calls.filter(([message]) => message.type === 'prepareProject'),
    ).toHaveLength(1);
    expect(lifecycle.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'requestIdeas' }),
    );
    const calls = lifecycle.send.mock.calls.length;
    receiveProjectPreparationResult(
      {
        type: 'prepareProjectResult',
        requestId: pending,
        projectId: 'project-1',
        status: 'created',
        errorCode: null,
      },
      transport,
    );
    expect(lifecycle.send).toHaveBeenCalledTimes(calls);
    respond({ projectId: 'project-1' });
    expect(await render()).toContain('Texto antes del timeout');
    await click('Siguiente');
  });

  it('keeps idea and answers when navigating and requires an explicit choice for an empty answer', async () => {
    await render();
    respond();
    await render();
    await change('new-idea-text', 'Una idea con detalle');
    await click('Siguiente');
    expect(await render()).toContain(IDEA_QUESTIONS[0].helper);
    expect(findControl(await tree(), (props) => props.children === 'Siguiente')?.disabled).toBe(
      true,
    );
    await choose('answer');
    expect(findControl(await tree(), (props) => props.children === 'Siguiente')?.disabled).toBe(
      true,
    );
    await change('idea-answer', 'Objetivo conservado');
    await click('Siguiente');
    await change('idea-answer', 'Usuarios conservados');
    await click('Anterior');
    expect(await render()).toContain('Objetivo conservado');
    await click('Anterior');
    expect(await render()).toContain('Una idea con detalle');
    await click('Siguiente');
    await click('Siguiente');
    expect(await render()).toContain('Usuarios conservados');
    expect(
      lifecycle.send.mock.calls.filter(([message]) => message.type === 'submitIdea'),
    ).toHaveLength(0);
    expect(getIdeasStore()).not.toHaveProperty('answers');
    expect(getIdeasStore()).not.toHaveProperty('text');
  });

  it('shows decide choices as assumptions, retains alternate text and submits structured answers only on save', async () => {
    await render();
    respond();
    await render();
    await change('new-idea-text', 'Una idea literal');
    await click('Siguiente');
    await change('idea-answer', 'Texto que conservar');
    await choose('decide');
    expect(await render()).toContain(IDEA_ASSUMPTION_TEXT);
    expect(findControl(await tree(), (props) => props.id === 'idea-answer')?.disabled).toBe(true);
    await click('Siguiente');
    await click('Anterior');
    await choose('answer');
    expect(await render()).toContain('Texto que conservar');
    await choose('decide');
    await click('Siguiente');
    for (const question of IDEA_QUESTIONS.slice(1)) {
      expect(await render()).toContain(question.helper);
      await choose('decide');
      await click('Siguiente');
    }
    const html = await render();
    expect(html).toContain('openQuestions');
    expect(html).toContain('panel de Decisiones');
    expect(html.split(IDEA_ASSUMPTION_TEXT)).toHaveLength(IDEA_QUESTIONS.length + 1);
    expect(html).not.toContain('Texto que conservar');
    expect(lifecycle.send).toHaveBeenCalledTimes(1);
    await click('Guardar idea');
    expect(lifecycle.send).toHaveBeenLastCalledWith({
      type: 'submitIdea',
      ...getIdeasStore().pending,
      text: 'Una idea literal',
      answers: IDEA_QUESTIONS.map((question) => ({
        questionId: question.id,
        choice: 'decide',
        text: '',
      })),
    });
  });

  it('confirms closing with content through both the close button and modal dismissal', async () => {
    await render();
    respond();
    await render();
    await change('new-idea-text', 'Conservar borrador');
    await click('Cerrar');
    expect(await render()).toContain('role="alertdialog"');
    expect(lifecycle.close).not.toHaveBeenCalled();
    await click('Seguir editando');
    expect(await render()).toContain('Conservar borrador');
    ((await tree()) as ReactElement<InteractiveProps>).props.onClose!();
    await render();
    await click('Descartar borrador');
    expect(lifecycle.close).toHaveBeenCalledOnce();
    expect(
      lifecycle.send.mock.calls.filter(([message]) => message.type === 'submitIdea'),
    ).toHaveLength(0);
    // A newly mounted dialog has no persisted draft.
    for (const effect of lifecycle.effects) effect.cleanup?.();
    lifecycle.states = [];
    lifecycle.effects = [];
    lifecycle.scheduled = [];
    expect(await render()).not.toContain('Conservar borrador');
  });

  it('closes an empty or saved dialog without asking to discard', async () => {
    await render();
    await click('Cerrar');
    expect(lifecycle.close).toHaveBeenCalledOnce();
    lifecycle.close.mockClear();
    respond();
    await render();
    await submit();
    setIdeasStore(applyIdeaResult(getIdeasStore(), { ...result, ...getIdeasStore().pending! }));
    await render();
    await click('Cerrar');
    expect(lifecycle.close).toHaveBeenCalledOnce();
    expect(await render()).not.toContain('role="alertdialog"');
  });

  it('hides the interview when privilege is revoked and still lets the user discard the draft', async () => {
    await render();
    respond();
    await render();
    await review();
    respond({ canSubmit: false, errorCode: 'denied' });
    expect(await render()).toContain('Solo lectura');
    expect(findAction(await tree(), 'Guardar idea')).toBeUndefined();
    expect(await render()).not.toContain('<textarea');
    expect(
      lifecycle.send.mock.calls.filter(([message]) => message.type === 'submitIdea'),
    ).toHaveLength(0);
    await click('Cerrar');
    expect(await render()).toContain('Descartar borrador');
    await click('Descartar borrador');
    expect(lifecycle.close).toHaveBeenCalledOnce();
  });

  it('requests preparation on mount and renders an accessible editable dialog after the reply', async () => {
    expect(await render()).toContain('Comprobando');
    expect(lifecycle.send).toHaveBeenCalledExactlyOnceWith({
      type: 'requestIdeas',
      requestId: getIdeasStore().requestId,
    });
    respond();
    const html = await render();
    for (const text of [
      'Nueva idea',
      'role="dialog"',
      'aria-modal="true"',
      '<textarea',
      'Tu idea',
      'Siguiente',
      'shadow-pixel',
      'no inicia ningún trabajo',
    ])
      expect(html).toContain(text);
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });

  it.each([
    ['missing_manifest', '.softwareagents/project.yaml'],
    ['invalid_manifest', 'no es válido'],
    ['no_project', 'no hay un Project'],
    ['unsupported_adapter', 'VS Code'],
    ['unsafe_storage', 'ruta de ideas'],
  ] as const)('explains %s and retries the actual read', async (errorCode, text) => {
    await render();
    respond({ canSubmit: false, errorCode });
    const html = await render();
    expect(html).toContain(text);
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
    findAction(await tree(), 'Reintentar lectura de ideas')!();
    expect(lifecycle.send).toHaveBeenCalledTimes(2);
    expect(await render()).toContain('Comprobando');
    respond();
    expect(await render()).not.toMatch(/<textarea[^>]*disabled/);
  });

  it('times out a missing read reply and retries with a fresh correlation id', async () => {
    await render();
    const stale = getIdeasStore().requestId!;
    vi.advanceTimersByTime(IDEA_REQUEST_TIMEOUT_MS);
    expect(await render()).toContain('No se pudieron leer o guardar las ideas');
    findAction(await tree(), 'Reintentar lectura de ideas')!();
    setIdeasStore(applyIdeasSnapshot(getIdeasStore(), { ...snapshot, requestId: stale }));
    expect(await render()).toContain('Comprobando');
    respond();
    expect(await render()).not.toMatch(/<textarea[^>]*disabled/);
  });

  it('times out an unconfirmed submit, retains text and never replays on reconnect', async () => {
    await render();
    respond();
    await submit();
    expect(await render()).toContain('Guardando…');
    findAction(await tree(), 'Cerrar')!();
    expect(lifecycle.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(IDEA_REQUEST_TIMEOUT_MS);
    expect(await render()).toContain('Consulta las ideas pendientes');
    expect(await render()).toContain('Una idea literal');
    lifecycle.state = 'reconnecting';
    await render();
    lifecycle.state = 'connected';
    await render();
    expect(
      lifecycle.send.mock.calls.filter(([message]) => message.type === 'submitIdea'),
    ).toHaveLength(1);
    expect(
      lifecycle.send.mock.calls.filter(([message]) => message.type === 'requestIdeas'),
    ).toHaveLength(2);
    expect(await render()).toContain('Consulta las ideas pendientes');
  });

  it('invalidates a pending submit on disconnect and ignores its late confirmation', async () => {
    await render();
    respond();
    await submit();
    const pending = getIdeasStore().pending!;
    lifecycle.state = 'reconnecting';
    await render();
    setIdeasStore(applyIdeaResult(getIdeasStore(), { ...result, ...pending }));
    expect(await render()).toContain('Consulta las ideas pendientes');
    lifecycle.state = 'connected';
    await render();
    respond();
    expect(await render()).not.toContain('Idea guardada:');
    expect(
      lifecycle.send.mock.calls.filter(([message]) => message.type === 'submitIdea'),
    ).toHaveLength(1);
  });

  it('retains an uncertain submission after closing with confirmed discard', async () => {
    await render();
    respond();
    await submit();
    vi.advanceTimersByTime(IDEA_REQUEST_TIMEOUT_MS);
    await render();
    await click('Cerrar');
    await click('Descartar borrador');
    expect(getIdeasStore().uncertain).toBe(true);
    expect(lifecycle.close).toHaveBeenCalledOnce();
    expect(
      lifecycle.send.mock.calls.filter(([message]) => message.type === 'submitIdea'),
    ).toHaveLength(1);
  });

  it('requires confirmed discard before consulting pending ideas after an uncertain submit', async () => {
    await render();
    respond();
    await submit();
    vi.advanceTimersByTime(IDEA_REQUEST_TIMEOUT_MS);
    await render();
    await click('Consultar ideas pendientes');
    expect(lifecycle.close).not.toHaveBeenCalled();
    expect(getIdeasStore().uncertain).toBe(true);
    await click('Seguir editando');
    expect(await render()).toContain('Una idea literal');
    await click('Consultar ideas pendientes');
    await click('Descartar borrador');
    expect(lifecycle.close).toHaveBeenCalledOnce();
    expect(getIdeasStore().uncertain).toBe(false);
    expect(
      lifecycle.send.mock.calls.filter(([message]) => message.type === 'requestIdeas'),
    ).toHaveLength(2);
    expect(
      lifecycle.send.mock.calls.filter(([message]) => message.type === 'submitIdea'),
    ).toHaveLength(1);
  });

  it('requests again after reconnecting from an offline mount', async () => {
    lifecycle.state = 'reconnecting';
    expect(await render()).toContain('Sin conexión');
    expect(lifecycle.send).not.toHaveBeenCalled();
    lifecycle.state = 'connected';
    expect(await render()).toContain('Comprobando');
    expect(lifecycle.send).toHaveBeenCalledOnce();
  });

  it.each([null, 'audit_failed'] as const)(
    'shows next steps after the correlated saved reply (%s)',
    async (errorCode) => {
      await render();
      respond();
      await submit();
      setIdeasStore(
        applyIdeaResult(getIdeasStore(), {
          ...result,
          ...getIdeasStore().pending!,
          errorCode,
        }),
      );
      const html = await render();
      expect(html).toContain('Idea guardada: <strong>FEAT-001</strong>');
      expect(html).toContain(result.idea!.command);
      for (const text of [
        'Qué pasa ahora',
        'Investigación previa opcional',
        'Requisitos:',
        'Decisiones',
        'Plan técnico:',
        'Desarrollo:',
        'Revisión y QA:',
        'Investigación posterior:',
        'espera por ti',
        'consume cuota',
        'estimaciones, no cargos',
        'Copiar comando',
        'carpeta del repositorio vinculada a esta oficina',
        'URL que pixel-agents mostró',
      ])
        expect(html).toContain(text);
      if (errorCode) expect(html).toContain('falta confirmar su auditoría');
      expect(html).not.toContain('<textarea');
    },
  );

  it('lists drafts separately from FeatureSpecs', async () => {
    const { IdeasList } = await import(listPath);
    const html = renderToStaticMarkup(createElement(IdeasList, { ideas: [result.idea] }));
    for (const text of [
      'Ideas pendientes · sin FeatureSpec',
      'Idea · pendiente',
      'data-state="idea_pending"',
      result.idea!.command,
      'Copiar comando',
      'carpeta del repositorio vinculada a esta oficina',
      'URL que pixel-agents mostró',
    ])
      expect(html).toContain(text);
    expect(html).not.toMatch(/progressbar|feature-cost|<textarea/);
  });
});

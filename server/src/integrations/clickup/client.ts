import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CLICKUP_API_BASE,
  CLICKUP_COMMENT_PAGE_SIZE,
  CLICKUP_COMMENT_PAGES_MAX,
  CLICKUP_RATE_LIMIT_MAX_WAIT_MS,
  CLICKUP_RATE_LIMIT_RETRIES,
  CLICKUP_SECRETS_FILE,
} from '../../constants.js';

/** The fields the mirror reads; everything else ClickUp returns is ignored. */
export interface ClickUpTask {
  id: string;
  customId: string | null;
  name: string;
  status: string;
}

/** Carries the HTTP status and route only: the token never reaches an error or a log. */
export class ClickUpError extends Error {
  constructor(
    readonly status: number,
    route: string,
  ) {
    super(`ClickUp ${route} respondió ${status}`);
  }
}

export interface ClickUpClientOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ClickUpClient {
  listTasks(listId: string): Promise<ClickUpTask[]>;
  setStatus(taskId: string, status: string): Promise<void>;
  comments(taskId: string): Promise<string[]>;
  comment(taskId: string, text: string): Promise<void>;
}

/** Operator secret: CLICKUP_TOKEN, else ~/.pixel-agents/secrets.json readable only by its owner. */
export function clickUpToken(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string | null {
  const fromEnv = env.CLICKUP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = path.join(home, '.pixel-agents', CLICKUP_SECRETS_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    throw new Error(`${file} debe ser legible solo por su propietario (chmod 600)`);
  let secrets: unknown;
  try {
    secrets = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // JSON.parse quotes the text around the error: that could be the token itself.
    throw new Error(`${file} no es JSON válido`);
  }
  const token =
    typeof secrets === 'object' && secrets !== null && 'clickupToken' in secrets
      ? secrets.clickupToken
      : undefined;
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

function taskFrom(raw: unknown): ClickUpTask | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const id = 'id' in raw ? raw.id : undefined;
  const name = 'name' in raw ? raw.name : undefined;
  const status =
    'status' in raw && typeof raw.status === 'object' && raw.status && 'status' in raw.status
      ? raw.status.status
      : undefined;
  const customId = 'custom_id' in raw ? raw.custom_id : null;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof status !== 'string') return null;
  return { id, name, status, customId: typeof customId === 'string' ? customId : null };
}

export function createClickUpClient({
  token,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}: ClickUpClientOptions): ClickUpClient {
  // ClickUp announces an exhausted window before it starts answering 429.
  let pausedUntil = 0;
  const waitFor = (resetHeader: string | null) => {
    const resetMs = Number(resetHeader) * 1000;
    return Number.isFinite(resetMs) && resetMs > 0
      ? Math.min(Math.max(resetMs - now(), 0), CLICKUP_RATE_LIMIT_MAX_WAIT_MS)
      : CLICKUP_RATE_LIMIT_MAX_WAIT_MS;
  };
  async function request(method: string, route: string, body?: object): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      if (pausedUntil > now()) await sleep(pausedUntil - now());
      const response = await fetch(`${CLICKUP_API_BASE}${route}`, {
        method,
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const reset = response.headers.get('X-RateLimit-Reset');
      if (response.headers.get('X-RateLimit-Remaining') === '0')
        pausedUntil = now() + waitFor(reset);
      if (response.status === 429 && attempt < CLICKUP_RATE_LIMIT_RETRIES) {
        await sleep(waitFor(reset));
        continue;
      }
      if (!response.ok) throw new ClickUpError(response.status, `${method} ${route.split('?')[0]}`);
      return response.json();
    }
  }
  return {
    async listTasks(listId) {
      const tasks: ClickUpTask[] = [];
      for (let page = 0; ; page++) {
        const result = await request(
          'GET',
          `/list/${encodeURIComponent(listId)}/task?include_closed=true&subtasks=true&page=${page}`,
        );
        const raw =
          typeof result === 'object' && result && 'tasks' in result && Array.isArray(result.tasks)
            ? result.tasks
            : [];
        for (const item of raw) {
          const task = taskFrom(item);
          if (task) tasks.push(task);
        }
        const lastPage =
          typeof result === 'object' && result && 'last_page' in result ? result.last_page : true;
        if (lastPage !== false || raw.length === 0) return tasks;
      }
    },
    async setStatus(taskId, status) {
      await request('PUT', `/task/${encodeURIComponent(taskId)}`, { status });
    },
    async comments(taskId) {
      // ClickUp returns the newest page; older pages continue from the oldest comment seen.
      const texts: string[] = [];
      let cursor = '';
      for (let page = 0; page < CLICKUP_COMMENT_PAGES_MAX; page++) {
        const result = await request('GET', `/task/${encodeURIComponent(taskId)}/comment${cursor}`);
        const raw =
          typeof result === 'object' &&
          result &&
          'comments' in result &&
          Array.isArray(result.comments)
            ? result.comments
            : [];
        let oldest: { id: string; date: string } | null = null;
        for (const item of raw) {
          if (typeof item !== 'object' || item === null) continue;
          if ('comment_text' in item && typeof item.comment_text === 'string')
            texts.push(item.comment_text);
          if (
            'id' in item &&
            typeof item.id === 'string' &&
            'date' in item &&
            typeof item.date === 'string'
          )
            oldest = { id: item.id, date: item.date };
        }
        if (raw.length < CLICKUP_COMMENT_PAGE_SIZE || !oldest) return texts;
        cursor = `?start=${encodeURIComponent(oldest.date)}&start_id=${encodeURIComponent(oldest.id)}`;
      }
      // Too many pages to be sure the comment is absent: refuse instead of posting a duplicate.
      throw new Error(`ClickUp task ${taskId}: demasiados comentarios para comprobar duplicados`);
    },
    async comment(taskId, text) {
      await request('POST', `/task/${encodeURIComponent(taskId)}/comment`, { comment_text: text });
    },
  };
}

import { setTimeout as delay } from 'timers/promises';

import { makeSource, type ResearchAdapter } from '../research.js';
import { type ResearchHttp, researchHttp } from '../researchHttp.js';
import { readableText } from './web.js';

const BOOK_INTERVAL_MS = 1100;
let nextRequest = 0;

interface Book {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  publisher?: string[];
  isbn?: string[];
  first_sentence?: string[];
}
interface Work {
  description?: string | { value?: string };
}
export function normalizeOpenLibrary(book: Book, work: Work = {}) {
  if (book.key && /^OL\d+W$/.test(book.key)) book = { ...book, key: `/works/${book.key}` };
  if (!book.key || !/^\/works\/OL\d+W$/.test(book.key) || !book.title) return [];
  const author = (book.author_name ?? []).join(', ').slice(0, 500);
  const description =
    typeof work.description === 'string' ? work.description : work.description?.value;
  const year = book.first_publish_year;
  return [
    makeSource({
      adapter: 'open-library',
      kind: 'book',
      url: `https://openlibrary.org${book.key}`,
      title: book.title.slice(0, 1000),
      ...(author ? { author } : {}),
      ...(year && year > 0 && year <= 9999
        ? { publishedAt: `${String(year).padStart(4, '0')}-01-01T00:00:00.000Z` }
        : {}),
      ...(book.publisher?.length ? { channel: book.publisher.join('; ').slice(0, 500) } : {}),
      ...(book.isbn?.length ? { citation: `ISBN: ${book.isbn.join(', ')}`.slice(0, 1000) } : {}),
      excerpt: readableText(description ?? book.first_sentence?.join(' ') ?? ''),
      language: 'und',
    }),
  ];
}
export function booksAdapter(http: ResearchHttp = researchHttp): ResearchAdapter {
  return {
    id: 'open-library',
    kinds: ['book'],
    search: async (query, options) => {
      if (options.limit <= 0) return [];
      const request = async (url: string) => {
        const now = Date.now();
        const slot = Math.max(now, nextRequest);
        nextRequest = slot + BOOK_INTERVAL_MS;
        await delay(slot - now, undefined, { signal: options.signal });
        return http(url, {
          signal: options.signal,
          headers: {
            'User-Agent':
              'SoftwareAgents-Research/1.0 (https://github.com/pixel-agents-hq/pixel-agents)',
          },
        });
      };
      const response = await request(
        `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${Math.min(options.limit, 100)}&fields=key,title,author_name,first_publish_year,publisher,isbn,first_sentence`,
      );
      const data = JSON.parse(response.text) as { docs?: Book[] };
      const sources = [];
      for (const book of (data.docs ?? []).slice(0, options.limit)) {
        if (book.key && /^OL\d+W$/.test(book.key)) book.key = `/works/${book.key}`;
        if (!book.key || !/^\/works\/OL\d+W$/.test(book.key)) continue;
        let work: Work = {};
        try {
          work = JSON.parse(
            (await request(`https://openlibrary.org${book.key}.json`)).text,
          ) as Work;
        } catch {
          options.signal.throwIfAborted(); /* Search metadata remains useful without a description. */
        }
        sources.push(...normalizeOpenLibrary(book, work));
      }
      return sources;
    },
  };
}

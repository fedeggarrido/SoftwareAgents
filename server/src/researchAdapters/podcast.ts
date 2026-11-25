import { RESEARCH_EXCERPT_CHARS } from '../../../core/src/research.js';
import { makeSource, type ResearchAdapter } from '../research.js';
import { type ResearchHttp, researchHttp } from '../researchHttp.js';
import { researchDeadline } from '../researchPolicy.js';
import { readableText } from './web.js';

const RSS_TYPE = /^(?:application\/(?:rss\+xml|xml)|text\/xml)\b/i;
const TRANSCRIPT_TYPE = /^text\/(?:plain|vtt)\b/i;
/** A single field or tag is never read past this, before any text cleanup runs on it. */
const FIELD_CHARS = 20_000;
const TAG_CHARS = 4_000;

interface XmlElement {
  attributes: string;
  content: string;
  end: number;
}

/** Linear scan: hostile feeds must not make a backtracking pattern block the abort timer. */
function openTag(xml: string, name: string, from = 0): { attributes: string; end: number } | null {
  const open = `<${name}`;
  for (let at = xml.indexOf(open, from); at >= 0; at = xml.indexOf(open, at + open.length)) {
    const next = xml[at + open.length];
    if (next !== '>' && next !== '/' && !/\s/.test(next ?? '')) continue;
    const close = xml.indexOf('>', at);
    if (close < 0) return null;
    return { attributes: xml.slice(at + open.length, close), end: close + 1 };
  }
  return null;
}

function element(xml: string, name: string, from = 0): XmlElement | null {
  const open = openTag(xml, name, from);
  if (!open) return null;
  const close = xml.indexOf(`</${name}`, open.end);
  if (close < 0) return null;
  return {
    attributes: open.attributes,
    content: xml.slice(open.end, close),
    end: close + name.length + 2,
  };
}

function withoutComments(xml: string): string {
  let text = '';
  let from = 0;
  for (let at = xml.indexOf('<!--'); at >= 0; at = xml.indexOf('<!--', from)) {
    text += xml.slice(from, at);
    const close = xml.indexOf('-->', at);
    if (close < 0) return text;
    from = close + 3;
  }
  return text + xml.slice(from);
}

const field = (xml: string, name: string) =>
  readableText(
    (element(xml, name)?.content ?? '')
      .slice(0, FIELD_CHARS)
      .replaceAll('<![CDATA[', '')
      .replaceAll(']]>', ''),
  );

/** Publisher RSS only: no directory search, audio, HTML pages or entity resolution. */
export function podcastAdapter(http: ResearchHttp = researchHttp): ResearchAdapter {
  return {
    id: 'podcast',
    kinds: ['podcast'],
    unavailable:
      'Podcast discovery unavailable; supply a publisher RSS feed URL with --source and --kinds podcast.',
    fetch: async (ref, options) => {
      if (options.limit <= 0) return [];
      options.signal.throwIfAborted();
      const response = await researchDeadline(
        http(ref, { signal: options.signal }),
        options.signal,
      );
      if (!RSS_TYPE.test(response.headers.get('content-type') ?? ''))
        throw new Error('Unsupported podcast content type');
      // Reject DTD/entity declarations rather than interpreting or fetching them.
      if (/<!DOCTYPE|<!ENTITY/i.test(response.text)) throw new Error('Unsupported podcast XML');
      const rss = element(withoutComments(response.text), 'rss');
      const channel = rss && element(rss.content, 'channel')?.content;
      if (!channel) throw new Error('Invalid podcast RSS');
      const metadata = channel.split(/<item\b/i)[0];
      const show = field(metadata, 'title').slice(0, 500);
      const author = field(metadata, 'itunes:author').slice(0, 500);
      const language = field(metadata, 'language').slice(0, 100) || 'und';
      const sources = [];
      let from = 0;
      for (let index = 0; index < options.limit; index += 1) {
        options.signal.throwIfAborted();
        const found = element(channel, 'item', from);
        if (!found) break;
        from = found.end;
        const item = found.content;
        const title = field(item, 'title').slice(0, 1000);
        if (!title) continue;
        const published = field(item, 'pubDate');
        const publishedAt =
          published && Number.isFinite(Date.parse(published))
            ? new Date(published).toISOString()
            : undefined;
        if (options.since && (!publishedAt || publishedAt.slice(0, 10) < options.since)) continue;
        let excerpt = field(item, 'description').slice(0, RESEARCH_EXCERPT_CHARS);
        // Only publisher-declared text/plain or VTT. Never follow enclosures or links.
        const tag = openTag(item, 'podcast:transcript')?.attributes.slice(0, TAG_CHARS);
        const attr = (name: string) =>
          tag
            ? new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)?.[2]
            : undefined;
        const transcriptUrl = attr('url');
        if (transcriptUrl && TRANSCRIPT_TYPE.test(attr('type') ?? ''))
          excerpt =
            (await readTranscript(transcriptUrl, ref, http, options.signal)) ??
            `Transcript unavailable. ${excerpt}`.slice(0, RESEARCH_EXCERPT_CHARS);
        const url = new URL(ref);
        url.hash = `episode-${index + 1}`;
        sources.push(
          makeSource({
            adapter: 'podcast',
            kind: 'podcast',
            url: url.href,
            title,
            ...(show ? { channel: show } : {}),
            ...(author ? { author } : {}),
            ...(publishedAt ? { publishedAt } : {}),
            excerpt,
            language,
          }),
        );
      }
      return sources;
    },
  };
}

/** A missing transcript costs that episode its transcript, never the rest of the feed. */
async function readTranscript(
  transcriptUrl: string,
  feedUrl: string,
  http: ResearchHttp,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const url = new URL(transcriptUrl.replace(/&amp;/g, '&'), feedUrl);
    const transcript = await researchDeadline(http(url.href, { signal }), signal);
    if (!TRANSCRIPT_TYPE.test(transcript.headers.get('content-type') ?? '')) return undefined;
    return transcript.text.slice(0, RESEARCH_EXCERPT_CHARS);
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

import { RESEARCH_EXCERPT_CHARS } from '../../../core/src/research.js';
import { makeSource, type ResearchAdapter } from '../research.js';
import { type ResearchHttp, researchHttp } from '../researchHttp.js';

export const YOUTUBE_IOS_VERSION = '20.10.4';
export const YOUTUBE_ANDROID_VERSION = '20.10.38';
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const PLAYER_HOSTS = ['www.youtube.com'] as const;
const PLAYER_CLIENTS = [
  { clientName: 'IOS', clientVersion: YOUTUBE_IOS_VERSION, deviceModel: 'iPhone16,2', hl: 'en' },
  {
    clientName: 'ANDROID',
    clientVersion: YOUTUBE_ANDROID_VERSION,
    androidSdkVersion: 30,
    hl: 'en',
  },
] as const;

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}
interface Player {
  videoDetails?: { title?: string; author?: string; videoId?: string };
  microformat?: { playerMicroformatRenderer?: { publishDate?: string } };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
}
export function timedText(text: string): string {
  const data = JSON.parse(text) as { events?: { segs?: { utf8?: string }[] }[] };
  const parts = (data.events ?? []).map((event) =>
    (event.segs ?? []).map((s) => (typeof s.utf8 === 'string' ? s.utf8 : '')).join(''),
  );
  return parts
    .join(' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, value: string) => {
      const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : entity;
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, RESEARCH_EXCERPT_CHARS);
}
export function isYoutube(ref: string): boolean {
  return ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(
    new URL(ref).hostname,
  );
}
export function youtubeAdapter(http: ResearchHttp = researchHttp): ResearchAdapter {
  return {
    id: 'youtube',
    kinds: ['video'],
    fetch: async (ref, options) => {
      const url = new URL(ref);
      if (url.protocol !== 'https:' || !isYoutube(ref) || url.username || url.password)
        throw new Error('Expected public YouTube video URL');
      const id =
        url.hostname === 'youtu.be'
          ? url.pathname.slice(1)
          : url.pathname === '/watch'
            ? url.searchParams.get('v')
            : /^\/(?:shorts|embed)\/([^/]+)$/.exec(url.pathname)?.[1];
      if (!id || !/^[\w-]{11}$/.test(id)) throw new Error('Invalid YouTube video ID');
      const canonical = `https://www.youtube.com/watch?v=${id}`;
      let player: Player = {};
      let track: CaptionTrack | undefined;
      let transcript = '';
      for (const client of PLAYER_CLIENTS) {
        try {
          player = JSON.parse(
            (
              await http(PLAYER_URL, {
                signal: options.signal,
                json: { context: { client }, videoId: id },
                allowedPostHosts: PLAYER_HOSTS,
              })
            ).text,
          ) as Player;
          const tracks = (
            player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
          ).filter((t) => t.baseUrl);
          const languages = [...new Set([options.language ?? 'en', 'en'])];
          track =
            languages.flatMap((language) =>
              tracks.filter((t) => t.kind !== 'asr' && t.languageCode === language),
            )[0] ??
            languages.flatMap((language) =>
              tracks.filter((t) => t.kind === 'asr' && t.languageCode === language),
            )[0] ??
            tracks.find((t) => t.kind !== 'asr') ??
            tracks[0];
          if (!track?.baseUrl) throw new Error('No public YouTube subtitles');
          const captionUrl = new URL(track.baseUrl);
          if (
            captionUrl.protocol !== 'https:' ||
            !['www.youtube.com', 'youtube.com', 'video.google.com'].includes(captionUrl.hostname) ||
            captionUrl.username ||
            captionUrl.password ||
            captionUrl.port ||
            !['/api/timedtext', '/timedtext'].includes(captionUrl.pathname)
          )
            throw new Error('Invalid YouTube caption endpoint');
          captionUrl.searchParams.set('fmt', 'json3');
          const text = (await http(captionUrl.href, { signal: options.signal })).text;
          transcript = text.trim() ? timedText(text) : '';
          if (!transcript) throw new Error('No public YouTube transcript text');
          break;
        } catch (error) {
          options.signal.throwIfAborted();
          if (client === PLAYER_CLIENTS[PLAYER_CLIENTS.length - 1]) throw error;
        }
      }
      if (!track || !transcript) throw new Error('No public YouTube subtitles');
      const published = player.microformat?.playerMicroformatRenderer?.publishDate;
      return [
        makeSource({
          adapter: 'youtube',
          kind: 'video',
          url: canonical,
          title: (player.videoDetails?.title ?? id).slice(0, 1000),
          ...(player.videoDetails?.author
            ? { channel: player.videoDetails.author.slice(0, 500) }
            : {}),
          ...(published && Number.isFinite(Date.parse(published))
            ? { publishedAt: new Date(published).toISOString() }
            : {}),
          language: track.languageCode?.slice(0, 100) || 'und',
          excerpt: transcript,
        }),
      ];
    },
  };
}

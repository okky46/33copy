// YouTube関連: URL→videoId抽出、oEmbedによるタイトル取得、動画長取得

import { fetchJson, fetchText } from "./chordSources/fetchUtil";

/** YouTube URLからvideoIdを抽出する。無効なら null */
export function extractVideoId(input: string): string | null {
  const s = input.trim();
  // すでにID形式
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const url = new URL(s);
    const host = url.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.slice(1).split("/")[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host === "youtube.com" || host === "music.youtube.com") {
      const v = url.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      // /embed/ID, /shorts/ID, /live/ID
      const m = url.pathname.match(/^\/(embed|shorts|live)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch {
    return null;
  }
  return null;
}

export interface VideoInfo {
  videoId: string;
  title: string;
  channelName: string;
  /** 秒。取得できなければ 0 */
  duration: number;
}

/** oEmbed + watchページからタイトル・チャンネル名・動画長を取得 (ベストエフォート) */
export async function fetchVideoInfo(videoId: string): Promise<VideoInfo> {
  const info: VideoInfo = { videoId, title: "", channelName: "", duration: 0 };

  const oembed = await fetchJson<{ title?: string; author_name?: string }>(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`
    )}&format=json`
  );
  if (oembed) {
    info.title = oembed.title ?? "";
    info.channelName = oembed.author_name ?? "";
  }

  // 動画長はwatchページのlengthSecondsから (取れなくてもクライアント側プレイヤーで補完)
  const watchHtml = await fetchText(`https://www.youtube.com/watch?v=${videoId}`, 8000);
  if (watchHtml) {
    const m = watchHtml.match(/"lengthSeconds"\s*:\s*"(\d+)"/);
    if (m) info.duration = parseInt(m[1], 10);
    if (!info.title) {
      const t = watchHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (t) info.title = t[1].replace(/\s*-\s*YouTube\s*$/i, "").trim();
    }
  }

  return info;
}

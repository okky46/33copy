// YouTube動画タイトルから曲名・アーティスト名を推定する

import type { SongGuess } from "./types";

/** タイトルから除去する不要語 */
const NOISE_PATTERNS: RegExp[] = [
  /official\s*(music\s*)?video/gi,
  /official\s*audio/gi,
  /official\s*(live\s*)?(ver\.?|version)/gi,
  /music\s*video/gi,
  /lyric\s*video/gi,
  /\bMV\b/g,
  /\bPV\b/g,
  /\bM\/V\b/g,
  /full\s*ver\.?/gi,
  /short\s*ver\.?/gi,
  /\bver\.?\s*\d*\b/gi,
  /\blive\b/gi,
  /\bcover(ed)?\b/gi,
  /\blyrics?\b/gi,
  /\bHD\b|\b4K\b/g,
  /THE FIRST TAKE/gi,
  /歌ってみた|弾いてみた|叩いてみた/g,
  /歌詞付き?|歌詞あり/g,
  /公式|ミュージックビデオ|ミュージック・ビデオ|リリックビデオ/g,
  /フルサイズ|フル\b/g,
  /(TV|テレビ)?アニメ[「『][^」』]*[」』]\s*(OP|ED|主題歌|挿入歌)?(テーマ)?/g,
  /(OP|ED|オープニング|エンディング)(テーマ|主題歌|映像)?/g,
  /主題歌|挿入歌|イメージソング/g,
  /ドラマ[「『][^」』]*[」』]/g,
  /映画[「『][^」』]*[」』]/g,
];

/** チャンネル名から除去する語 */
const CHANNEL_NOISE = /\s*(official\s*(you\s*tube\s*)?channel|official|オフィシャル|公式(チャンネル)?|\bVEVO\b|\s*-\s*Topic)\s*/gi;

function stripBrackets(s: string): string {
  // 括弧の中身が不要語だけなら括弧ごと削除
  return s.replace(/[(（\[［【〈《]([^)）\]］】〉》]*)[)）\]］】〉》]/g, (whole, inner) => {
    const cleaned = removeNoise(inner);
    return cleaned.trim().length <= 1 ? " " : whole;
  });
}

function removeNoise(s: string): string {
  let out = s;
  for (const re of NOISE_PATTERNS) out = out.replace(re, " ");
  return out.replace(/\s+/g, " ").trim();
}

function cleanup(s: string): string {
  return s
    .replace(/^[\s\-–—/|:：・]+|[\s\-–—/|:：・]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanChannelName(channel: string): string {
  return cleanup(channel.replace(CHANNEL_NOISE, " "));
}

/**
 * タイトルとチャンネル名から曲名・アーティスト名を推定する。
 * J-POPでよくあるパターンを順に試す:
 *   Artist「Song」 / Artist『Song』 / 【Artist】Song
 *   Artist - Song / Song - Artist / Song / Artist
 */
export function guessSong(videoTitle: string, channelName: string): SongGuess {
  const channelArtist = cleanChannelName(channelName);
  let t = stripBrackets(videoTitle);
  t = removeNoise(t);

  let title = "";
  let artist = "";
  let confidence = 0.4;

  // Artist「Song」/ Artist『Song』
  let m = t.match(/^(.*?)[「『]([^」』]+)[」』]/);
  if (m && m[2].trim()) {
    artist = cleanup(m[1]);
    title = cleanup(m[2]);
    confidence = 0.85;
  }

  // 【Artist】Song or 【Song】Artist
  if (!title) {
    m = t.match(/^【([^】]+)】\s*(.+)$/);
    if (m) {
      artist = cleanup(m[1]);
      title = cleanup(m[2]);
      confidence = 0.6;
    }
  }

  // Artist - Song / Song - Artist (区切り: - – — / | ／)
  if (!title) {
    const parts = t.split(/\s*[-–—|／]\s+|\s+[-–—|／/]\s*|\s*\/\s*/).map(cleanup).filter(Boolean);
    if (parts.length >= 2) {
      // チャンネル名と一致する側をアーティストとみなす
      const chLower = channelArtist.toLowerCase();
      const idx = parts.findIndex(
        (p) => chLower && (p.toLowerCase().includes(chLower) || chLower.includes(p.toLowerCase()))
      );
      if (idx >= 0) {
        artist = parts[idx];
        title = parts.filter((_, i) => i !== idx).join(" ");
        confidence = 0.8;
      } else {
        // J-POP公式は「Artist - Song」が多い
        artist = parts[0];
        title = parts.slice(1).join(" ");
        confidence = 0.55;
      }
    }
  }

  // 区切りなし → タイトル全体を曲名、チャンネル名をアーティストに
  if (!title) {
    title = cleanup(t);
    artist = channelArtist;
    confidence = 0.45;
  }
  if (!artist) {
    artist = channelArtist;
  }
  // アーティストと曲名が同じになってしまった場合
  if (title && artist && title.toLowerCase() === artist.toLowerCase()) {
    artist = channelArtist;
    confidence = 0.4;
  }

  const queries = buildQueries(title, artist);
  return { title, artist, confidence, queries };
}

/** コード譜検索用のクエリ群を作る */
export function buildQueries(title: string, artist: string): string[] {
  const qs: string[] = [];
  if (title && artist) {
    qs.push(`${title} ${artist} コード`);
    qs.push(`${artist} ${title} コード`);
    qs.push(`${title} ${artist} 弾き語り コード`);
    qs.push(`${artist} ${title} chords`);
  }
  if (title) {
    qs.push(`${title} コード`);
    qs.push(`${title} ピアノ コード`);
  }
  return Array.from(new Set(qs));
}

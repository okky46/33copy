// 検索結果の「コード掲載ページらしさ」スコアリング
// 上から採用ではなく、ドメイン・タイトル・URL・曲名/アーティスト一致で評価し、
// 歌詞ページ・販売ページ・ニュースなどを理由つきで除外する

import type { SearchHit } from "./webSearch";

/** コード掲載サイトのドメインと重み。U-FRETは特に重要な参考サイト */
export const CHORD_DOMAINS: Record<string, number> = {
  "www.ufret.jp": 1.0,
  "ufret.jp": 1.0,
  "gakufu.gakki.me": 0.9,
  "ja.chordwiki.org": 0.9,
  "music.j-total.net": 0.8,
  "www.easter-egg.me": 0.8,
  "easter-egg.me": 0.8,
  "utaten.com": 0.6, // /chord/ ページのみコードあり
  "chordsketch.com": 0.6,
  "www.chordbook.jp": 0.5,
};

const POSITIVE_KEYWORDS = /(ギターコード|ピアノコード|ウクレレコード|コード譜|コード進行|弾き語り|コード|chords?|guitar\s*chord)/i;
const NEGATIVE_KEYWORDS: [RegExp, string][] = [
  [/歌詞|lyrics?|うたてん(?!.*コード)|歌ネット|j-lyric|utamap/i, "歌詞ページの可能性"],
  [/通販|購入|販売|store|shop|amazon|楽天|タワーレコード|hmv/i, "販売ページ"],
  [/ニュース|news|インタビュー|interview|発売決定|リリース/i, "ニュース記事"],
  [/wikipedia|ウィキペディア/i, "百科事典"],
  [/youtube\.com|youtu\.be|niconico|nicovideo|spotify|apple\.com|music\.apple/i, "動画・配信ページ"],
  [/チケット|ライブ情報|コンサート/i, "ライブ情報"],
];

/** 比較用の正規化 (大小・全半角・スペース・記号ゆれを吸収) */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　・、。!?！？'"'"″′()（）\[\]【】≠☆★♪♡〜~\-–—]/g, "");
}

export interface HitScore {
  score: number;
  accepted: boolean;
  reasons: string[];
}

/** 検索ヒット1件をスコアリングする */
export function scoreHit(hit: SearchHit, songTitle: string, artist: string): HitScore {
  const reasons: string[] = [];
  let score = 0;

  let domain = "";
  try {
    domain = new URL(hit.url).hostname;
  } catch {
    return { score: -10, accepted: false, reasons: ["URL不正"] };
  }

  const domainWeight = CHORD_DOMAINS[domain];
  if (domainWeight !== undefined) {
    score += 2.5 * domainWeight;
    reasons.push(`コードサイト (${domain})`);
  }

  const text = `${hit.title} ${hit.url}`;
  if (POSITIVE_KEYWORDS.test(text)) {
    score += 1.2;
    reasons.push("コード系キーワードあり");
  }

  const normTitle = normalizeForMatch(songTitle);
  const normArtist = normalizeForMatch(artist);
  const normText = normalizeForMatch(`${hit.title} ${hit.snippet}`);
  if (normTitle && normTitle.length >= 2 && normText.includes(normTitle)) {
    score += 1.5;
    reasons.push("曲名一致");
  } else if (normTitle) {
    reasons.push("曲名不一致");
    score -= 1.0;
  }
  if (normArtist && normArtist.length >= 2 && normText.includes(normArtist)) {
    score += 1.0;
    reasons.push("アーティスト一致");
  }

  // ネガティブ判定 (コードサイト・コードキーワードがない場合のみ強く効かせる)
  for (const [re, label] of NEGATIVE_KEYWORDS) {
    if (re.test(text)) {
      const penalty = domainWeight !== undefined || POSITIVE_KEYWORDS.test(text) ? 0.5 : 2.5;
      score -= penalty;
      reasons.push(`減点: ${label}`);
    }
  }

  // U-FRET 動画プラスはコードデータが取りにくいので通常版よりわずかに下げる
  if (/ufret\.jp/.test(domain) && /video/.test(hit.url)) {
    score -= 0.3;
    reasons.push("U-FRET動画プラス");
  }

  const accepted = score >= 1.8;
  return { score, accepted, reasons };
}

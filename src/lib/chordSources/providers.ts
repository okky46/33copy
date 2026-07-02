// 外部コード譜プロバイダー群
// すべてベストエフォート: 失敗したら null / 空を返し、全体は止めない

import type { ExternalSourceResult } from "../types";
import { fetchText, decodeEntities } from "./fetchUtil";
import { extractChordsFromHtml } from "./extract";

/** コード譜が載っていることが多い既知ドメイン */
const CHORD_DOMAINS = [
  "ja.chordwiki.org",
  "music.j-total.net",
  "gakufu.gakki.me",
  "www.ufret.jp",
  "ufret.jp",
  "chordsketch.com",
  "www.chordbook.jp",
];

function pageTitleOf(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

/** 曲名・アーティスト名がページタイトルにどれだけ含まれるか (0..1) */
function titleMatchScore(pageTitle: string, song: string, artist: string): number {
  const t = pageTitle.toLowerCase();
  let score = 0;
  if (song && t.includes(song.toLowerCase())) score += 0.6;
  if (artist && t.includes(artist.toLowerCase())) score += 0.4;
  return score;
}

/** URLを取得してコードを抽出し、ソース結果にする */
export async function fetchChordPage(
  url: string,
  provider: string,
  song: string,
  artist: string
): Promise<ExternalSourceResult | null> {
  const html = await fetchText(url);
  if (!html) return null;
  const chords = extractChordsFromHtml(html);
  if (chords.length < 4) return null;
  const pageTitle = pageTitleOf(html);
  const match = titleMatchScore(pageTitle, song, artist);
  // コード数が実用域(8〜400)にあるほど・タイトル一致するほど高スコア
  const sizeScore = chords.length >= 8 && chords.length <= 400 ? 1 : 0.5;
  return {
    provider,
    url,
    pageTitle,
    chords,
    score: 0.3 * sizeScore + 0.7 * match,
  };
}

/** ChordWiki: サイト内検索 → 上位ページからコード抽出 */
export async function searchChordWiki(
  song: string,
  artist: string
): Promise<ExternalSourceResult[]> {
  const q = encodeURIComponent(`${song} ${artist}`.trim());
  const searchUrl = `https://ja.chordwiki.org/wiki.cgi?c=search&q=${q}`;
  const html = await fetchText(searchUrl);
  if (!html) return [];
  // 検索結果のリンク /wiki/xxx or wiki.cgi?t=xxx
  const links = new Set<string>();
  const re = /href="(\/wiki\/[^"]+|\/wiki\.cgi\?t=[^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && links.size < 3) {
    links.add(`https://ja.chordwiki.org${decodeEntities(m[1])}`);
  }
  const results = await Promise.all(
    [...links].map((url) => fetchChordPage(url, "ChordWiki", song, artist))
  );
  return results.filter((r): r is ExternalSourceResult => !!r);
}

/** DuckDuckGo HTML検索でコード譜ページを探し、既知ドメインを優先して取得 */
export async function searchWeb(
  queries: string[],
  song: string,
  artist: string
): Promise<ExternalSourceResult[]> {
  const found: { url: string; domain: string }[] = [];
  const seen = new Set<string>();

  for (const query of queries.slice(0, 3)) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const html = await fetchText(url);
    if (!html) continue;
    // 結果リンク抽出 (uddg=エンコード済みURL)
    const re = /href="[^"]*?uddg=([^"&]+)[^"]*"|class="result__a"[^>]*href="(https?:\/\/[^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      let target = "";
      try {
        target = decodeURIComponent(m[1] ?? m[2] ?? "");
      } catch {
        continue;
      }
      if (!target.startsWith("http")) continue;
      let domain = "";
      try {
        domain = new URL(target).hostname;
      } catch {
        continue;
      }
      if (!CHORD_DOMAINS.includes(domain)) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      found.push({ url: target, domain });
    }
    if (found.length >= 5) break;
  }

  // ドメインの多様性を保ちつつ最大4ページ取得
  const byDomain = new Map<string, string[]>();
  for (const f of found) {
    const list = byDomain.get(f.domain) ?? [];
    if (list.length < 2) list.push(f.url);
    byDomain.set(f.domain, list);
  }
  const targets = [...byDomain.values()].flat().slice(0, 4);
  const results = await Promise.all(
    targets.map((url) => {
      const domain = new URL(url).hostname;
      return fetchChordPage(url, domain, song, artist);
    })
  );
  return results.filter((r): r is ExternalSourceResult => !!r);
}

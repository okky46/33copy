// Web検索プロバイダー (DuckDuckGo HTML / Bing)
// APIキー不要のHTMLエンドポイントをパースする。どちらかが失敗しても他方で継続する
//
// 検索サイトはHTML構造が変わりやすく、専用セレクタが0件になることがある。
// その場合は「検索エンジン自身のドメインを除いた外部リンクを広く拾う」
// フォールバック抽出を試み、構造変化に対してある程度耐性を持たせる。

import { decodeEntities, fetchText, type FetchDiag } from "./fetchUtil";

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  searchProvider: string;
}

/** 検索実行1回分の診断情報 (デバッグ表示用) */
export interface SearchDiag extends FetchDiag {
  usedFallback?: boolean;
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** 検索エンジン自身のドメイン・広告/追跡リンクを除いた外部リンクを広く拾うフォールバック抽出 */
function extractGenericLinks(html: string, excludeDomainRe: RegExp, provider: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < 20) {
    const url = decodeEntities(m[1]);
    let domain = "";
    try {
      domain = new URL(url).hostname;
    } catch {
      continue;
    }
    if (excludeDomainRe.test(domain)) continue;
    const title = stripTags(m[2]);
    if (!title || title.length < 2) continue;
    hits.push({ url, title, snippet: "", searchProvider: `${provider} (fallback)` });
  }
  return hits;
}

const DDG_OWN_DOMAIN_RE = /duckduckgo\.com$|duck\.co$/i;
const BING_OWN_DOMAIN_RE = /bing\.com$|microsoft\.com$|msn\.com$|live\.com$/i;

/** DuckDuckGo HTML版の検索結果をパースする (null = 取得失敗) */
export async function searchDuckDuckGo(
  query: string,
  diag?: SearchDiag
): Promise<SearchHit[] | null> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=jp-jp`;
  const html = await fetchText(url, 9000, diag);
  if (!html) return null;
  const hits = parseDuckDuckGoHtml(html);
  if (hits.length > 0) return hits;
  const fallback = extractGenericLinks(html, DDG_OWN_DOMAIN_RE, "DuckDuckGo");
  if (diag && fallback.length > 0) diag.usedFallback = true;
  return fallback;
}

export function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // まず結果リンクの位置をすべて集め、次のリンクまでの範囲からスニペットを拾う
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const links: { href: string; title: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) {
    links.push({ href: m[1], title: m[2], start: m.index, end: linkRe.lastIndex });
  }
  for (let i = 0; i < links.length && hits.length < 12; i++) {
    let target = decodeEntities(links[i].href);
    // //duckduckgo.com/l/?uddg=<encoded> 形式のリダイレクトを展開
    const uddg = target.match(/uddg=([^&]+)/);
    if (uddg) {
      try {
        target = decodeURIComponent(uddg[1]);
      } catch {
        continue;
      }
    }
    if (!target.startsWith("http")) continue;
    const block = html.slice(links[i].end, links[i + 1] ? links[i + 1].start : links[i].end + 2000);
    const snipM = block.match(
      /<(?:a|div|span)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/
    );
    hits.push({
      url: target,
      title: stripTags(links[i].title),
      snippet: snipM ? stripTags(snipM[1]) : "",
      searchProvider: "DuckDuckGo",
    });
  }
  return hits;
}

/** BingのHTML検索結果をパースする (null = 取得失敗) */
export async function searchBing(query: string, diag?: SearchDiag): Promise<SearchHit[] | null> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=ja&cc=jp`;
  const html = await fetchText(url, 9000, diag);
  if (!html) return null;
  const hits = parseBingHtml(html);
  if (hits.length > 0) return hits;
  const fallback = extractGenericLinks(html, BING_OWN_DOMAIN_RE, "Bing");
  if (diag && fallback.length > 0) diag.usedFallback = true;
  return fallback;
}

export function parseBingHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // 結果ブロック: <li class="b_algo"> <h2><a href="URL">タイトル</a></h2> ... <p>概要</p>
  const blockRe =
    /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && hits.length < 12) {
    const block = m[1];
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const target = decodeEntities(link[1]);
    if (!target.startsWith("http")) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    hits.push({
      url: target,
      title: stripTags(link[2]),
      snippet: snippet ? stripTags(snippet[1]) : "",
      searchProvider: "Bing",
    });
  }
  return hits;
}

export const SEARCH_ENGINES: {
  name: string;
  run: (q: string, diag?: SearchDiag) => Promise<SearchHit[] | null>;
}[] = [
  { name: "DuckDuckGo", run: searchDuckDuckGo },
  { name: "Bing", run: searchBing },
];

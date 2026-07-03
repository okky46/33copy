// Web検索プロバイダー (DuckDuckGo HTML / Bing)
// APIキー不要のHTMLエンドポイントをパースする。どちらかが失敗しても他方で継続する

import { decodeEntities, fetchText } from "./fetchUtil";

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  searchProvider: string;
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** DuckDuckGo HTML版の検索結果をパースする (null = 取得失敗) */
export async function searchDuckDuckGo(query: string): Promise<SearchHit[] | null> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=jp-jp`;
  const html = await fetchText(url, 9000);
  if (!html) return null;
  return parseDuckDuckGoHtml(html);
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
export async function searchBing(query: string): Promise<SearchHit[] | null> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=ja&cc=jp`;
  const html = await fetchText(url, 9000);
  if (!html) return null;
  return parseBingHtml(html);
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
  run: (q: string) => Promise<SearchHit[] | null>;
}[] = [
  { name: "DuckDuckGo", run: searchDuckDuckGo },
  { name: "Bing", run: searchBing },
];

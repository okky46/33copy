// 外部コード譜の収集オーケストレーター
// - コードサイトへの直接検索 (U-FRET / ChordWiki)
// - Web検索 (DuckDuckGo / Bing) + コードページらしさスコアリング
// すべてベストエフォート: 失敗しても全体は止めず、デバッグ情報に記録する
//
// 注意: 外部サイトの内容はユーザーの初期コード候補を作るための参考情報としてのみ使い、
// 丸ごとの保存・再配布はしない (保存するのはコード名の列と出典URLのみ)

import type { AnalyzeDebug, ExternalSourceResult, SongGuess } from "../types";
import { fetchText, decodeEntities } from "./fetchUtil";
import { extractChordsDetailed, extractPageMeta } from "./extract";
import { SEARCH_ENGINES, type SearchHit } from "./webSearch";
import { normalizeForMatch, scoreHit } from "./scoring";

const MAX_FETCH_PAGES = 6;
const MAX_PER_DOMAIN = 2;
const SEARCH_DEADLINE_MS = 22000;

function pageTitleOf(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

/** 曲名・アーティスト名がページタイトルにどれだけ含まれるか (0..1) */
function titleMatchScore(pageTitle: string, song: string, artist: string): number {
  const t = normalizeForMatch(pageTitle);
  let score = 0;
  if (song && t.includes(normalizeForMatch(song))) score += 0.6;
  if (artist && t.includes(normalizeForMatch(artist))) score += 0.4;
  return score;
}

/** URLを取得してコードを抽出し、ソース結果にする */
export async function fetchChordPage(
  url: string,
  provider: string,
  song: string,
  artist: string,
  debug?: AnalyzeDebug
): Promise<ExternalSourceResult | null> {
  const html = await fetchText(url);
  if (!html) {
    debug?.fetched.push({ url, provider, ok: false, chordCount: 0, note: "取得失敗" });
    return null;
  }
  const { chords, strategy } = extractChordsDetailed(html);
  const meta = extractPageMeta(html);
  if (chords.length < 4) {
    debug?.fetched.push({
      url, provider, ok: false, chordCount: chords.length,
      note: `コード抽出不足 (${strategy})`,
    });
    return null;
  }
  const pageTitle = pageTitleOf(html);
  const match = titleMatchScore(pageTitle, song, artist);
  const sizeScore = chords.length >= 8 && chords.length <= 400 ? 1 : 0.5;
  debug?.fetched.push({
    url, provider, ok: true, chordCount: chords.length, capo: meta.capo,
    note: strategy,
  });
  return {
    provider,
    url,
    pageTitle,
    chords,
    score: 0.3 * sizeScore + 0.7 * match,
    capo: meta.capo,
    keyLabel: meta.keyLabel,
    note: strategy,
  };
}

/** ChordWiki: サイト内検索 → 上位ページのURL候補 */
async function searchChordWikiDirect(
  song: string,
  artist: string,
  debug: AnalyzeDebug
): Promise<SearchHit[]> {
  const q = `${song} ${artist}`.trim();
  const searchUrl = `https://ja.chordwiki.org/wiki.cgi?c=search&q=${encodeURIComponent(q)}`;
  const html = await fetchText(searchUrl);
  if (!html) {
    debug.searches.push({ provider: "ChordWiki直接", query: q, hitCount: 0, error: "取得失敗" });
    return [];
  }
  const hits: SearchHit[] = [];
  const re = /<a[^>]*href="(\/wiki\/[^"]+|\/wiki\.cgi\?t=[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < 4) {
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    if (!title) continue;
    hits.push({
      url: `https://ja.chordwiki.org${decodeEntities(m[1])}`,
      title: `${title} - ChordWiki`,
      snippet: "",
      searchProvider: "ChordWiki直接",
    });
  }
  debug.searches.push({ provider: "ChordWiki直接", query: q, hitCount: hits.length });
  return hits;
}

/** U-FRET: サイト内検索 → 曲ページのURL候補 (特に重要な参考サイト) */
async function searchUfretDirect(
  song: string,
  artist: string,
  debug: AnalyzeDebug
): Promise<SearchHit[]> {
  const q = `${song} ${artist}`.trim();
  const searchUrl = `https://www.ufret.jp/search.php?key=${encodeURIComponent(q)}`;
  const html = await fetchText(searchUrl);
  if (!html) {
    debug.searches.push({ provider: "U-FRET直接", query: q, hitCount: 0, error: "取得失敗" });
    return [];
  }
  const hits: SearchHit[] = [];
  // 曲ページリンク: song.php?data=NNNN
  const re = /<a[^>]*href="((?:https?:\/\/www\.ufret\.jp\/)?song\.php\?data=\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < 4) {
    let url = decodeEntities(m[1]);
    if (!url.startsWith("http")) url = `https://www.ufret.jp/${url}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    hits.push({ url, title: `${title} - U-FRET`, snippet: "", searchProvider: "U-FRET直接" });
  }
  debug.searches.push({ provider: "U-FRET直接", query: q, hitCount: hits.length });
  return hits;
}

/**
 * 外部コード譜を収集するメインエントリ。
 * 1. コードサイト直接検索とWeb検索を並行実行
 * 2. ヒットをコードページらしさでスコアリング (採用/除外理由をデバッグに記録)
 * 3. ドメイン多様性を保って上位ページを取得・抽出
 */
export async function collectSources(
  songGuess: SongGuess,
  debug: AnalyzeDebug
): Promise<ExternalSourceResult[]> {
  const { title: song, artist, queries } = songGuess;
  const started = Date.now();
  const deadline = () => Date.now() - started > SEARCH_DEADLINE_MS;

  // --- 1. 検索 (直接 + Web検索エンジン) ---
  const allHits: SearchHit[] = [];
  const directResults = await Promise.all([
    searchUfretDirect(song, artist, debug).catch(() => []),
    searchChordWikiDirect(song, artist, debug).catch(() => []),
  ]);
  for (const hits of directResults) allHits.push(...hits);

  // Web検索: クエリを順に投げ、十分な候補が集まるか時間切れまで
  outer: for (const query of queries.slice(0, 5)) {
    for (const engine of SEARCH_ENGINES) {
      if (deadline()) break outer;
      try {
        const hits = await engine.run(query);
        if (hits === null) {
          debug.searches.push({ provider: engine.name, query, hitCount: 0, error: "取得失敗" });
        } else {
          debug.searches.push({ provider: engine.name, query, hitCount: hits.length });
          allHits.push(...hits);
        }
      } catch (e) {
        debug.searches.push({
          provider: engine.name, query, hitCount: 0,
          error: e instanceof Error ? e.message : "error",
        });
      }
      const acceptedSoFar = dedupeAndScore(allHits, song, artist).filter((c) => c.accepted).length;
      if (acceptedSoFar >= 6) break outer;
    }
  }

  // --- 2. スコアリング ---
  const scored = dedupeAndScore(allHits, song, artist);
  for (const c of scored) {
    debug.candidates.push({
      url: c.hit.url,
      title: c.hit.title,
      score: Math.round(c.score * 100) / 100,
      accepted: c.accepted,
      reasons: c.reasons,
    });
  }

  // --- 3. 取得対象の選定 (スコア順、ドメイン多様性を確保) ---
  const targets: { url: string; provider: string }[] = [];
  const perDomain = new Map<string, number>();
  for (const c of scored.filter((c) => c.accepted).sort((a, b) => b.score - a.score)) {
    if (targets.length >= MAX_FETCH_PAGES) break;
    let domain = "";
    try {
      domain = new URL(c.hit.url).hostname;
    } catch {
      continue;
    }
    const count = perDomain.get(domain) ?? 0;
    if (count >= MAX_PER_DOMAIN) continue;
    perDomain.set(domain, count + 1);
    targets.push({ url: c.hit.url, provider: domain.replace(/^www\./, "") });
  }

  // --- 4. 取得・抽出 ---
  const results = await Promise.all(
    targets.map((t) => fetchChordPage(t.url, t.provider, song, artist, debug).catch(() => null))
  );
  const sources = results.filter((r): r is ExternalSourceResult => !!r);
  debug.adopted = sources.map((s) => s.url);
  return sources;
}

function dedupeAndScore(
  hits: SearchHit[],
  song: string,
  artist: string
): { hit: SearchHit; score: number; accepted: boolean; reasons: string[] }[] {
  const seen = new Set<string>();
  const out: { hit: SearchHit; score: number; accepted: boolean; reasons: string[] }[] = [];
  for (const hit of hits) {
    const key = hit.url.replace(/[?#].*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const s = scoreHit(hit, song, artist);
    // 直接検索由来はサイト内検索が既に曲名で絞っているため下駄を履かせる
    const direct = hit.searchProvider.includes("直接") ? 1.0 : 0;
    out.push({ hit, score: s.score + direct, accepted: s.accepted || s.score + direct >= 1.8, reasons: s.reasons });
  }
  return out;
}

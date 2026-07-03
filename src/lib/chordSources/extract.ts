// HTMLからコード進行を抽出する汎用エクストラクタ
// 多くのコード譜サイトに対して「それなりに」動くことを目指す

import { CHORD_TOKEN_RE } from "../chords";
import { decodeEntities } from "./fetchUtil";

export interface ExtractedChord {
  name: string;
  section?: string;
}

const SECTION_RE =
  /(イントロ|Aメロ|Bメロ|Cメロ|Dメロ|落ちサビ|大サビ|サビ|間奏|アウトロ|intro|interlude|outro|verse\s*\d*|chorus|pre-?chorus|bridge|ending)/i;

/** セクション名を正規化 */
function normalizeSection(s: string): string {
  const m = s.match(SECTION_RE);
  return m ? m[1] : s;
}

function normalizeChordToken(tok: string): string | null {
  const t = tok
    .normalize("NFKC") // 全角英数・記号を半角へ (Ａｍ７ → Am7)
    .replace(/[（(].*?[)）]$/, (m) => (/[#b♯♭+\-59]/.test(m) ? m : "")) // (b5)等は残す
    .replace(/[、。,.!?！？]$/g, "")
    .trim();
  if (!t || t.length > 10) return null;
  if (/^N\.?C\.?$/i.test(t)) return "N.C.";
  if (!CHORD_TOKEN_RE.test(t)) return null;
  // 歌詞の英単語 (A, Ah など) を誤検出しないよう、単独の A/E は文脈で拾う側に任せる
  return t;
}

export interface PageMeta {
  /** カポ位置 (例: 2)。半音下げチューニングは -1 */
  capo?: number;
  /** キー表記 (例: "E♭", "Am") */
  keyLabel?: string;
}

/** ページからカポ・キー情報を検出する */
export function extractPageMeta(html: string): PageMeta {
  const text = decodeEntities(html.replace(/<[^>]+>/g, " ")).normalize("NFKC");
  const meta: PageMeta = {};

  const capoM =
    text.match(/カポ[^0-9+-]{0,4}([0-9]{1,2})/) ??
    text.match(/capo[^0-9+-]{0,4}([0-9]{1,2})/i);
  if (capoM) {
    const capo = parseInt(capoM[1], 10);
    if (capo >= 0 && capo <= 9) meta.capo = capo;
  }
  if (meta.capo === undefined && /半音下げ/.test(text)) meta.capo = -1;
  if (/カポ\s*(?:なし|無し|0)/.test(text)) meta.capo = 0;

  const keyM = text.match(/(?:原曲)?(?:キー|Key)\s*[:：=]?\s*([A-G][#♯♭]?m?)(?![A-Za-z0-9])/i);
  if (keyM) meta.keyLabel = keyM[1];

  return meta;
}

/**
 * script内のJS文字列リテラルからコード列を抽出する。
 * U-FRETなど、コード進行をJSデータとして埋め込みクライアント側で描画するサイト向け。
 * 引用符で囲まれた文字列のうちコード表記率が十分高い場合のみ採用する (誤検出防止)。
 */
export function extractChordsFromScripts(html: string, maxChords = 400): ExtractedChord[] {
  const scripts: string[] = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) scripts.push(m[1]);

  let best: ExtractedChord[] = [];
  for (const script of scripts) {
    const strRe = /["']([^"'\\\n]{1,12})["']/g;
    const tokens: string[] = [];
    let total = 0;
    let sm: RegExpExecArray | null;
    while ((sm = strRe.exec(script)) && tokens.length < maxChords) {
      const raw = sm[1].trim();
      if (!raw || raw.length > 10) continue;
      // 英数字を含む短い文字列のみ分母に数える
      if (!/[A-Za-zＡ-Ｚａ-ｚ]/.test(raw)) continue;
      total++;
      const tok = normalizeChordToken(raw);
      if (tok) tokens.push(tok);
    }
    // コード率が高く数が十分なスクリプトだけをコードデータとみなす
    if (tokens.length >= 16 && total > 0 && tokens.length / total >= 0.6) {
      if (tokens.length > best.length) best = tokens.map((name) => ({ name }));
    }
  }
  return best;
}

/** 抽出結果と使った戦略 (デバッグ用) */
export function extractChordsDetailed(
  html: string,
  maxChords = 400
): { chords: ExtractedChord[]; strategy: string } {
  const fromMarkup = extractChordsFromHtml(html, maxChords);
  if (fromMarkup.length >= 8) return { chords: fromMarkup, strategy: "markup/text" };
  const fromScripts = extractChordsFromScripts(html, maxChords);
  if (fromScripts.length > fromMarkup.length) {
    return { chords: fromScripts, strategy: "script-data" };
  }
  return { chords: fromMarkup, strategy: "markup/text" };
}

/**
 * HTML全体からコード列を抽出する。
 * 優先順:
 *  1. class="chord" 等のマークアップ付きコード (ChordWiki, U-Fret系)
 *  2. [C] ブラケット表記
 *  3. コードトークンが密集した行 (テキスト系コード譜)
 */
export function extractChordsFromHtml(html: string, maxChords = 400): ExtractedChord[] {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  // 1. マークアップ付きコード (span class="chord" / <rt>)
  const marked: ExtractedChord[] = [];
  let currentSection: string | undefined;
  const markedRe = /<(?:span|div|p)[^>]*class="[^"]*\bchord\b[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|p)>|<rt[^>]*>([\s\S]*?)<\/rt>/gi;
  let m: RegExpExecArray | null;
  // セクション検出のため位置も追う
  const sectionMarks: { pos: number; name: string }[] = [];
  const secRe = /[<＜\[【]\s*([^<>＜＞\[\]【】]{1,12})\s*[>＞\]】]/g;
  let sm: RegExpExecArray | null;
  while ((sm = secRe.exec(noScript))) {
    const inner = decodeEntities(sm[1]);
    if (SECTION_RE.test(inner) && !CHORD_TOKEN_RE.test(inner.trim())) {
      sectionMarks.push({ pos: sm.index, name: normalizeSection(inner) });
    }
  }
  const sectionAt = (pos: number): string | undefined => {
    let name: string | undefined;
    for (const s of sectionMarks) {
      if (s.pos <= pos) name = s.name;
      else break;
    }
    return name;
  };
  while ((m = markedRe.exec(noScript))) {
    const raw = decodeEntities((m[1] ?? m[2] ?? "").replace(/<[^>]+>/g, "")).trim();
    const tok = normalizeChordToken(raw);
    if (tok) marked.push({ name: tok, section: sectionAt(m.index) });
    if (marked.length >= maxChords) break;
  }
  if (marked.length >= 8) return marked;

  // タグを落として行ベースのテキストにする
  const text = decodeEntities(
    noScript
      .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/pre)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
  const lines = text.split(/\n/);

  // 2. [C] ブラケット表記 (ChordWiki原文など)
  const bracket: ExtractedChord[] = [];
  currentSection = undefined;
  for (const line of lines) {
    const secM = line.match(/^[\s]*[<＜\[【]?\s*(イントロ|Aメロ|Bメロ|Cメロ|サビ|間奏|アウトロ|intro|verse\s*\d*|chorus|bridge|outro)/i);
    if (secM) currentSection = normalizeSection(secM[1]);
    const re = /\[([A-G][#b♯♭]?[^\[\]\s]{0,8})\]/g;
    let bm: RegExpExecArray | null;
    while ((bm = re.exec(line))) {
      const tok = normalizeChordToken(bm[1]);
      if (tok) bracket.push({ name: tok, section: currentSection });
      if (bracket.length >= maxChords) break;
    }
  }
  if (bracket.length >= 8) return bracket;

  // 3. コードトークン密集行
  const dense: ExtractedChord[] = [];
  currentSection = undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (SECTION_RE.test(trimmed) && trimmed.length <= 20) {
      currentSection = normalizeSection(trimmed);
      continue;
    }
    const tokens = trimmed.split(/[\s|｜/→,、･・]+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 40) continue;
    const chordToks = tokens.map(normalizeChordToken).filter((t): t is string => !!t);
    // 行のほとんどがコードならコード行とみなす
    if (chordToks.length >= 2 && chordToks.length / tokens.length >= 0.7) {
      for (const t of chordToks) {
        dense.push({ name: t, section: currentSection });
        if (dense.length >= maxChords) break;
      }
    }
  }
  if (dense.length >= 8) return dense;

  // 最も多く取れたものを返す (8未満でも)
  const candidates = [marked, bracket, dense].sort((a, b) => b.length - a.length);
  return candidates[0];
}

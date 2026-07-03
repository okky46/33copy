// 複数外部ソースのコード進行を照合し、最も妥当な初期進行を選ぶ
//
// 外部コード譜はサイトごとにキー違い・カポ表記・簡略コードがあるため:
// - カポ表記が取れたソースは実音キーへ事前移調する
// - ソース間の比較は12通りの移調を試し、最も一致する移調量で照合する
// - 複数ソースで (移調補正後に) 一致するコードは信頼度を上げる
// - 複数ソースがあるのに一致しないコードは disputed (要確認) にする

import type { AnalyzeDebug, AnalyzeResult, ExternalSourceResult } from "../types";
import { parseChord, transposeChordName } from "../chords";

/** コード列 → 正規化した出現コードの集合 */
function vocab(chords: { name: string }[], transpose = 0): Set<string> {
  return new Set(
    chords.map((c) => parseChord(transposeChordName(c.name, transpose)).name)
  );
}

function bigrams(chords: { name: string }[], transpose = 0): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < chords.length - 1; i++) {
    s.add(
      `${transposeChordName(chords[i].name, transpose)}>${transposeChordName(chords[i + 1].name, transpose)}`
    );
  }
  return s;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  a.forEach((x) => { if (b.has(x)) inter++; });
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

/** aを基準に、bを何半音移調すると最も一致するか (冒頭コード・進行の近さで評価) */
export function bestTransposition(
  a: ExternalSourceResult,
  b: ExternalSourceResult
): { k: number; similarity: number } {
  const va = vocab(a.chords);
  const ba = bigrams(a.chords);
  let best = { k: 0, similarity: -1 };
  for (let k = 0; k < 12; k++) {
    const sim =
      0.5 * jaccard(va, vocab(b.chords, k)) + 0.5 * jaccard(ba, bigrams(b.chords, k));
    // 同一キー (k=0) をわずかに優遇し、僅差でキー補正しない
    const adjusted = sim + (k === 0 ? 0.03 : 0);
    if (adjusted > best.similarity) best = { k, similarity: adjusted };
  }
  return best;
}

/** カポ表記が取れたソースを実音キーへ移調する (カポNの表記コード = 実音より N半音低い) */
function applyCapo(source: ExternalSourceResult): ExternalSourceResult {
  if (!source.capo) return source;
  return {
    ...source,
    chords: source.chords.map((c) => ({
      ...c,
      name: transposeChordName(c.name, source.capo!),
    })),
  };
}

/**
 * ソース群から初期コード進行を決める。
 * - 各ソースを「ページタイトル一致 + 他ソースとの (移調補正後) 一致度」でスコアリング
 * - 最良ソースの進行をベースに採用
 * - 各コードの一致ソース数・不一致 (disputed) を記録
 */
export function buildConsensus(
  rawSources: ExternalSourceResult[],
  debug?: AnalyzeDebug
): AnalyzeResult["progression"] {
  if (rawSources.length === 0) return [];

  const sources = rawSources.map(applyCapo);
  for (const s of sources) {
    if (s.capo) debug?.keyCorrections.push(`${s.provider}: カポ${s.capo} → +${s.capo}半音補正`);
  }

  // 実用的な長さのソースを優先
  const usable = sources.filter((s) => s.chords.length >= 8);
  const pool = usable.length > 0 ? usable : sources;

  // ペアごとの最適移調と類似度
  const trans: { k: number; similarity: number }[][] = pool.map(() => []);
  for (let i = 0; i < pool.length; i++) {
    for (let j = 0; j < pool.length; j++) {
      trans[i][j] = i === j ? { k: 0, similarity: 1 } : bestTransposition(pool[i], pool[j]);
    }
  }

  const agreement = pool.map((_, i) => {
    if (pool.length === 1) return 0;
    let sum = 0;
    for (let j = 0; j < pool.length; j++) {
      if (j !== i) sum += trans[i][j].similarity;
    }
    return sum / (pool.length - 1);
  });

  let bestIdx = 0;
  let bestScore = -1;
  pool.forEach((s, i) => {
    const score = s.score + agreement[i] * 0.8 + Math.min(s.chords.length / 100, 0.3);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  });

  const base = pool[bestIdx];
  const others = pool
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => i !== bestIdx);

  // 他ソースの語彙を「ベースに最も合う移調」で正規化して照合に使う
  const otherVocabs = others.map(({ s, i }) => {
    const t = trans[bestIdx][i];
    if (t.k !== 0 && t.similarity > 0.25) {
      debug?.keyCorrections.push(
        `${s.provider}: ${base.provider}に対しキー違い → +${t.k}半音補正で照合`
      );
    }
    return {
      provider: s.provider,
      vocab: vocab(s.chords, t.k),
      usable: t.similarity > 0.15, // 全く別の曲らしきソースは照合に使わない
    };
  }).filter((v) => v.usable);

  const baseQuality = Math.min(0.85, 0.45 + base.score * 0.3 + agreement[bestIdx] * 0.3);

  return base.chords.map((c) => {
    const norm = parseChord(c.name).name;
    const matched = otherVocabs.filter((v) => v.vocab.has(norm));
    const agreeRatio = otherVocabs.length > 0 ? matched.length / otherVocabs.length : 0;
    // 複数ソースがあるのに1つも一致しない → 要確認
    const disputed = otherVocabs.length >= 1 && matched.length === 0 && !parseChord(c.name).isNoChord;
    return {
      name: c.name,
      section: c.section,
      sourceCount: 1 + matched.length,
      providers: [base.provider, ...matched.map((v) => v.provider)],
      score: Math.min(0.95, baseQuality * (0.7 + 0.3 * agreeRatio) + agreeRatio * 0.15),
      disputed,
    };
  });
}

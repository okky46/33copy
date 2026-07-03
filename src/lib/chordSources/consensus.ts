// 複数外部ソースのコード進行を照合し、最も妥当な初期進行を選ぶ

import type { AnalyzeResult, ExternalSourceResult } from "../types";
import { parseChord } from "../chords";

/** コード列 → 出現コードの集合 (照合用) */
function vocab(chords: { name: string }[]): Set<string> {
  return new Set(chords.map((c) => parseChord(c.name).name));
}

/** 2ソースの類似度: コード語彙のJaccard + バイグラム重なり */
function similarity(a: ExternalSourceResult, b: ExternalSourceResult): number {
  const va = vocab(a.chords);
  const vb = vocab(b.chords);
  let inter = 0;
  va.forEach((c) => { if (vb.has(c)) inter++; });
  const union = va.size + vb.size - inter;
  const jaccard = union > 0 ? inter / union : 0;

  const bigrams = (chords: { name: string }[]) => {
    const s = new Set<string>();
    for (let i = 0; i < chords.length - 1; i++) s.add(`${chords[i].name}>${chords[i + 1].name}`);
    return s;
  };
  const ba = bigrams(a.chords);
  const bb = bigrams(b.chords);
  let binter = 0;
  ba.forEach((g) => { if (bb.has(g)) binter++; });
  const bunion = ba.size + bb.size - binter;
  const bigramSim = bunion > 0 ? binter / bunion : 0;

  return 0.5 * jaccard + 0.5 * bigramSim;
}

/**
 * ソース群から初期コード進行を決める。
 * - 各ソースを「ページタイトル一致 + 他ソースとの一致度」でスコアリング
 * - 最良ソースの進行をベースに採用
 * - 各コードの信頼度 = ベースソース品質 × そのコードを含む他ソース割合
 *
 * 注: キー違い(カポ・移調)のソースは一致度が下がり自然に選ばれにくくなる。
 * 転調を考慮したアラインメントは将来の改善ポイント。
 */
export function buildConsensus(
  sources: ExternalSourceResult[]
): AnalyzeResult["progression"] {
  if (sources.length === 0) return [];

  // 実用的な長さのソースを優先
  const usable = sources.filter((s) => s.chords.length >= 8);
  const pool = usable.length > 0 ? usable : sources;

  const agreement = pool.map((s) => {
    if (pool.length === 1) return 0;
    let sum = 0;
    for (const other of pool) {
      if (other === s) continue;
      sum += similarity(s, other);
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
  const others = pool.filter((s) => s !== base);
  const otherVocabs = others.map((s) => ({ provider: s.provider, vocab: vocab(s.chords) }));

  const baseQuality = Math.min(0.85, 0.45 + base.score * 0.3 + agreement[bestIdx] * 0.3);

  return base.chords.map((c) => {
    const norm = parseChord(c.name).name;
    const matched = otherVocabs.filter((v) => v.vocab.has(norm));
    const agreeRatio = others.length > 0 ? matched.length / others.length : 0;
    return {
      name: c.name,
      section: c.section,
      sourceCount: 1 + matched.length,
      providers: [base.provider, ...matched.map((v) => v.provider)],
      score: Math.min(0.95, baseQuality * (0.7 + 0.3 * agreeRatio) + agreeRatio * 0.15),
    };
  });
}

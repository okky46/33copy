// 外部コード譜が見つからなかったときのフォールバック進行
// J-POPで頻出の進行を仮置きし、ユーザーの叩き台にする

import type { AnalyzeResult } from "../types";

/** J-POP頻出進行 (キーC基準) */
const COMMON_PROGRESSIONS: { name: string; chords: string[] }[] = [
  {
    // 王道進行 (IV△7 → V → iii → vi)
    name: "王道進行",
    chords: ["Fmaj7", "G", "Em7", "Am7"],
  },
  {
    // カノン進行
    name: "カノン進行",
    chords: ["C", "G/B", "Am", "Em/G", "F", "C/E", "F", "G"],
  },
  {
    // 小室進行 (vi → IV → V → I)
    name: "小室進行",
    chords: ["Am", "F", "G", "C"],
  },
];

/** videoIdから決定的に頻出進行を選ぶ (毎回同じ結果になるように) */
export function buildFallbackProgression(videoId: string): {
  progression: AnalyzeResult["progression"];
  progressionName: string;
} {
  let hash = 0;
  for (const ch of videoId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const pick = COMMON_PROGRESSIONS[Math.abs(hash) % COMMON_PROGRESSIONS.length];

  // イントロ+Aメロ+サビ っぽく2周分をセクション付きで
  const progression: AnalyzeResult["progression"] = [];
  const sections = ["イントロ", "Aメロ", "サビ"];
  for (const section of sections) {
    for (const name of pick.chords) {
      progression.push({
        name,
        section,
        sourceCount: 0,
        confidence: 0.15,
        source: "fallback",
      });
    }
  }
  return { progression, progressionName: pick.name };
}

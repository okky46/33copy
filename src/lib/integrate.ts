// 統合レイヤー: 外部コード情報と音源解析結果を統合し、
// タイムラインと解析サマリーを作る。
//
// 品質ルール:
// - 根拠 (外部ソース / 音源解析 / ユーザー入力 / 保存済み) がなければタイムラインは空
// - 外部コード譜は正解扱いせず、音源解析と矛盾する箇所は信頼度を下げて「要確認」にする
// - 一致する箇所は信頼度を上げる

import type {
  AnalyzeResult,
  AnalysisSummary,
  AudioChordCandidate,
  BeatGrid,
  ChordEvent,
} from "./types";
import { parseChord } from "./chords";
import {
  buildFromAudioChords,
  makeAssumedGrid,
  placeOnGrid,
} from "./timeline";

export interface IntegrationInput {
  progression: AnalyzeResult["progression"];
  sourceCount: number;
  duration: number;
  /** 音源解析結果 (あれば) */
  audioGrid?: BeatGrid | null;
  audioChords?: AudioChordCandidate[] | null;
}

export interface IntegrationOutput {
  timeline: ChordEvent[];
  grid: BeatGrid | null;
  summary: AnalysisSummary;
}

/**
 * 外部コード情報と音源解析結果からタイムラインを組み立てる。
 * どちらの根拠もない場合はタイムラインを空にし、その旨をメッセージで返す。
 */
export function integrate(input: IntegrationInput): IntegrationOutput {
  const { progression, sourceCount, duration, audioGrid, audioChords } = input;
  const hasExternal = progression.length >= 4 && sourceCount >= 1;
  const hasAudio = !!audioGrid && audioGrid.confidence > 0.05;

  // 根拠なし → 正直に「取得できなかった」
  if (!hasExternal && !hasAudio) {
    return {
      timeline: [],
      grid: null,
      summary: {
        sourceCount: 0,
        timingConfidence: "low",
        needsReviewCount: 0,
        message:
          "十分なコード候補を取得できませんでした。曲名・アーティスト名を修正して再検索するか、手動でコードを追加してください。音源ファイルをアップロードして解析することもできます。",
      },
    };
  }

  // 音源解析のみ → chromaベースのコード候補を使う
  if (!hasExternal && hasAudio) {
    const timeline = buildFromAudioChords(audioChords ?? []);
    const needsReviewCount = timeline.filter((e) => e.needsReview).length;
    if (timeline.length === 0) {
      return {
        timeline: [],
        grid: audioGrid!,
        summary: {
          sourceCount: 0,
          bpm: audioGrid!.bpm,
          timingConfidence: gridTimingLabel(audioGrid!),
          needsReviewCount: 0,
          message:
            "外部コード譜は見つかりませんでした。BPMと拍グリッドは推定できましたが、コード候補を十分に取得できませんでした。グリッドを頼りに手動でコードを追加してください。",
        },
      };
    }
    return {
      timeline,
      grid: audioGrid!,
      summary: {
        sourceCount: 0,
        bpm: audioGrid!.bpm,
        timingConfidence: gridTimingLabel(audioGrid!),
        needsReviewCount,
        message:
          "外部コード譜は見つかりませんでした。音源解析からBPMとコード候補を推定しました。精度は低めなので、再生しながら確認してください。",
      },
    };
  }

  // 外部コードあり → グリッド (実測 or 仮定) に配置
  const grid = hasAudio ? audioGrid! : makeAssumedGrid(progression.length, duration);
  if (!grid) {
    return {
      timeline: [],
      grid: null,
      summary: {
        sourceCount,
        timingConfidence: "low",
        needsReviewCount: 0,
        message:
          "動画の長さを取得できず、タイムラインを生成できませんでした。再生後にもう一度お試しください。",
      },
    };
  }

  let timeline = placeOnGrid(progression, grid, duration);

  // 音源解析のコード候補と照合して信頼度を補正
  if (hasAudio && audioChords && audioChords.length > 0) {
    timeline = verifyWithAudio(timeline, audioChords);
  }

  const needsReviewCount = timeline.filter((e) => e.needsReview).length;
  const timingConfidence = hasAudio ? gridTimingLabel(grid) : "low";

  const parts: string[] = [`外部コードソース: ${sourceCount}件`];
  if (hasAudio) parts.push(`推定BPM: ${grid.bpm}`);
  parts.push(`タイミング信頼度: ${timingConfidence}`);
  if (needsReviewCount > 0) parts.push(`要確認コード: ${needsReviewCount}箇所`);

  const hint = hasAudio
    ? "コード切り替わりは拍・小節グリッドに沿って配置しています。"
    : "音源が未解析のため、タイミングは仮のグリッドです。音源ファイルをアップロードすると曲に合わせられます。";

  return {
    timeline,
    grid,
    summary: {
      sourceCount,
      bpm: hasAudio ? grid.bpm : undefined,
      timingConfidence,
      needsReviewCount,
      message: `コード候補を生成しました。${parts.join("、")}。${hint}`,
    },
  };
}

/**
 * 外部コード譜由来のタイムラインを音源解析のコード候補と照合する。
 * - 区間が重なる音源コードとルート・トライアドが一致 → 信頼度を上げる
 * - 明らかに矛盾 (ルートも構成音も合わない) → 信頼度を下げ「要確認」
 */
export function verifyWithAudio(
  timeline: ChordEvent[],
  audioChords: AudioChordCandidate[]
): ChordEvent[] {
  return timeline.map((ev) => {
    const overlaps = audioChords.filter(
      (a) => a.end > ev.start + 0.1 && a.start < ev.end - 0.1 && a.confidence >= 0.3
    );
    if (overlaps.length === 0) return ev;

    const evParsed = parseChord(ev.name);
    const evTones = new Set(evParsed.intervals.map((iv) => (evParsed.rootPc + iv) % 12));

    // 重なり時間で重み付けした一致度
    let matchW = 0;
    let totalW = 0;
    for (const a of overlaps) {
      const w = Math.min(a.end, ev.end) - Math.max(a.start, ev.start);
      const aParsed = parseChord(a.chord);
      const rootMatch = aParsed.rootPc === evParsed.rootPc;
      // 音源側トライアドが外部コードの構成音に概ね含まれるか
      const aTones = [aParsed.rootPc, (aParsed.rootPc + (aParsed.intervals.includes(3) ? 3 : 4)) % 12, (aParsed.rootPc + 7) % 12];
      const contained = aTones.filter((pc) => evTones.has(pc)).length / aTones.length;
      const agree = rootMatch ? 1 : contained >= 0.67 ? 0.7 : 0;
      matchW += agree * w;
      totalW += w;
    }
    const agreement = totalW > 0 ? matchW / totalW : 0;

    if (agreement >= 0.7) {
      return {
        ...ev,
        confidence: bump(ev.confidence),
        evidence: { ...ev.evidence, audioConfidence: round2(agreement), notes: [...(ev.evidence?.notes ?? []), "音源解析と一致"] },
      };
    }
    if (agreement <= 0.25) {
      return {
        ...ev,
        confidence: drop(ev.confidence),
        needsReview: true,
        evidence: { ...ev.evidence, audioConfidence: round2(agreement), notes: [...(ev.evidence?.notes ?? []), "音源解析と不一致の可能性"] },
      };
    }
    return { ...ev, evidence: { ...ev.evidence, audioConfidence: round2(agreement) } };
  });
}

function bump(c: ChordEvent["confidence"]): ChordEvent["confidence"] {
  if (c === "low" || c === "unknown") return "medium";
  return "high";
}

function drop(c: ChordEvent["confidence"]): ChordEvent["confidence"] {
  if (c === "high") return "medium";
  return "low";
}

function gridTimingLabel(grid: BeatGrid): "high" | "medium" | "low" {
  if (grid.source !== "audio") return "low";
  if (grid.confidence >= 0.6) return "high";
  if (grid.confidence >= 0.3) return "medium";
  return "low";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

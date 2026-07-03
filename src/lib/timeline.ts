// コードタイムライン: 拍・小節グリッドに沿った配置と編集操作
//
// 方針:
// - 動画長への単純均等割りはしない
// - 音源解析があれば実測グリッド、なければ「仮定グリッド」(信頼度低として明示) に配置
// - 根拠のないコード進行は生成しない (呼び出し側で空タイムラインを許容する)

import type { AnalyzeResult, AudioChordCandidate, BeatGrid, ChordEvent, SnapMode } from "./types";
import { parseChord } from "./chords";

let idCounter = 0;
export function newEventId(): string {
  idCounter += 1;
  return `ch_${Date.now().toString(36)}_${idCounter}`;
}

/**
 * 音源解析がない場合の仮定グリッドを作る。
 * 「外部コード譜のコード数 ≒ 小節数」という仮定から仮のBPMを導き、
 * J-POPで現実的なテンポ帯 (70-180) に折り込む。
 * あくまで叩き台であり、confidence は低く設定し UI で「要調整」と明示する。
 */
export function makeAssumedGrid(chordCount: number, duration: number): BeatGrid | null {
  if (chordCount < 1 || duration <= 0) return null;
  let barSec = duration / chordCount; // 1コード=1小節と仮定
  let bpm = 240 / barSec; // 4/4想定
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  bpm = Math.round(bpm * 10) / 10;
  const beatSec = 60 / bpm;
  const beats: number[] = [];
  const downbeats: number[] = [];
  for (let t = 0, i = 0; t <= duration + 1e-6; t += beatSec, i++) {
    beats.push(round3(t));
    if (i % 4 === 0) downbeats.push(round3(t));
  }
  return { bpm, beats, downbeats, firstDownbeat: 0, confidence: 0.2, source: "assumed" };
}

/**
 * コード進行をグリッドの小節単位に配置する。
 * コード数と小節数の比率から「1小節あたりのコード数 / 1コードあたりの小節数」を決め、
 * コード切り替わりを拍・小節頭にスナップした状態で並べる。
 * コードが尽きたらそこで止める (無理に引き伸ばさない)。
 */
export function placeOnGrid(
  progression: AnalyzeResult["progression"],
  grid: BeatGrid,
  duration: number
): ChordEvent[] {
  const n = progression.length;
  if (n === 0 || grid.downbeats.length < 2) return [];

  const bars = grid.downbeats.filter((d) => d < duration);
  const m = bars.length;
  const ratio = n / m;

  // 切り替わり位置の列を作る (小節頭 or 小節内の拍)
  const slots: { start: number; end: number }[] = [];
  if (ratio >= 1.5) {
    // 1小節に2コード (1・3拍目)
    for (let b = 0; b < m && slots.length < n; b++) {
      const barStart = bars[b];
      const barEnd = b + 1 < grid.downbeats.length ? grid.downbeats[b + 1] : duration;
      const half = barStart + (barEnd - barStart) / 2;
      slots.push({ start: barStart, end: half });
      if (slots.length < n) slots.push({ start: half, end: barEnd });
    }
  } else {
    // 1コードにつき barsPerChord 小節
    const barsPerChord = Math.max(1, Math.min(4, Math.round(1 / ratio)));
    for (let b = 0; b < m && slots.length < n; b += barsPerChord) {
      const start = bars[b];
      const endBarIdx = b + barsPerChord;
      const end = endBarIdx < grid.downbeats.length ? grid.downbeats[endBarIdx] : duration;
      slots.push({ start, end: Math.min(end, duration) });
    }
  }

  const timingConfidence = grid.source === "audio" ? Math.min(0.85, grid.confidence) : 0.2;

  return slots.map((slot, i) => {
    const p = progression[i];
    const parsed = parseChord(p.name);
    return {
      id: newEventId(),
      name: p.name,
      root: parsed.root,
      quality: parsed.quality,
      bass: parsed.bass,
      start: round3(slot.start),
      end: round3(slot.end),
      source: p.sourceCount > 1 ? ("merged" as const) : ("external" as const),
      confidence: confidenceFromEvidence(p.sourceCount, grid.source === "audio"),
      evidence: {
        externalSources: p.providers,
        timingConfidence,
      },
      needsReview: false,
      edited: false,
      section: p.section,
    };
  });
}

/** 外部ソース数とグリッド実測有無から信頼度を決める */
export function confidenceFromEvidence(sourceCount: number, hasAudioGrid: boolean): ChordEvent["confidence"] {
  if (sourceCount >= 2) return hasAudioGrid ? "high" : "medium";
  if (sourceCount === 1) return hasAudioGrid ? "medium" : "low";
  return "unknown";
}

/** 音源解析のコード候補からタイムラインを作る (外部コード譜がない場合) */
export function buildFromAudioChords(audioChords: AudioChordCandidate[]): ChordEvent[] {
  return audioChords.map((c) => {
    const parsed = parseChord(c.chord);
    return {
      id: newEventId(),
      name: c.chord,
      root: parsed.root,
      quality: parsed.quality,
      bass: parsed.bass,
      start: round3(c.start),
      end: round3(c.end),
      source: "audio-analysis" as const,
      confidence: (c.confidence >= 0.75 ? "medium" : "low") as ChordEvent["confidence"],
      evidence: { audioConfidence: c.confidence },
      needsReview: c.confidence < 0.6,
      edited: false,
    };
  });
}

/** 時刻をグリッドにスナップする */
export function snapTime(t: number, grid: BeatGrid | null | undefined, mode: SnapMode): number {
  if (!grid || mode === "off") return t;
  const points = mode === "bar" ? grid.downbeats : grid.beats;
  if (points.length === 0) return t;
  // 二分探索で最近傍
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  const after = points[lo];
  const before = lo > 0 ? points[lo - 1] : after;
  return Math.abs(after - t) < Math.abs(t - before) ? after : before;
}

/** 全コードを delta 秒だけ前後にずらす (タイミング全体補正) */
export function shiftTimeline(timeline: ChordEvent[], delta: number): ChordEvent[] {
  return timeline.map((e) => ({
    ...e,
    start: round3(Math.max(0, e.start + delta)),
    end: round3(Math.max(0.05, e.end + delta)),
  }));
}

/** 現在時間に対応するコードのインデックスを返す (-1 = なし) */
export function chordIndexAt(timeline: ChordEvent[], t: number): number {
  let lo = 0, hi = timeline.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].start <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (ans >= 0 && t < timeline[ans].end) return ans;
  return -1;
}

/** start順にソートし、重なりを解消した新しい配列を返す */
export function normalizeTimeline(timeline: ChordEvent[]): ChordEvent[] {
  const sorted = [...timeline].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].end > sorted[i + 1].start) {
      sorted[i] = { ...sorted[i], end: sorted[i + 1].start };
    }
  }
  return sorted.filter((e) => e.end - e.start > 0.05);
}

/** 時刻tでコードを分割し、後半を新しいコードにする (「ここで次のコード」) */
export function splitAt(timeline: ChordEvent[], t: number, nextName?: string): ChordEvent[] {
  const idx = chordIndexAt(timeline, t);
  if (idx < 0) return timeline;
  const cur = timeline[idx];
  if (t - cur.start < 0.1 || cur.end - t < 0.1) return timeline;
  const name = nextName ?? (timeline[idx + 1]?.name || cur.name);
  const parsed = parseChord(name);
  const newEvent: ChordEvent = {
    ...cur,
    id: newEventId(),
    name,
    root: parsed.root,
    quality: parsed.quality,
    bass: parsed.bass,
    start: t,
    end: cur.end,
    source: "manual",
    confidence: "high",
    needsReview: false,
    edited: true,
    memo: undefined,
  };
  const updated = [...timeline];
  updated[idx] = { ...cur, end: t, edited: true };
  updated.splice(idx + 1, 0, newEvent);
  return updated;
}

/** 時刻tに新しいコードを追加する (既存コードがあれば分割) */
export function addChordAt(timeline: ChordEvent[], t: number, name: string, defaultDur = 2): ChordEvent[] {
  const idx = chordIndexAt(timeline, t);
  if (idx >= 0) return splitAt(timeline, t, name);
  const parsed = parseChord(name);
  const next = timeline.find((e) => e.start > t);
  const end = Math.min(t + defaultDur, next ? next.start : t + defaultDur);
  const ev: ChordEvent = {
    id: newEventId(),
    name,
    root: parsed.root,
    quality: parsed.quality,
    bass: parsed.bass,
    start: t,
    end,
    source: "manual",
    confidence: "high",
    needsReview: false,
    edited: true,
  };
  return normalizeTimeline([...timeline, ev]);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

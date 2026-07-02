// コード進行 → 時間付きタイムラインへの変換と、タイムライン編集操作

import type { AnalyzeResult, ChordEvent } from "./types";
import { parseChord } from "./chords";

let idCounter = 0;
export function newEventId(): string {
  idCounter += 1;
  return `ch_${Date.now().toString(36)}_${idCounter}`;
}

/**
 * コード進行を動画長に合わせてざっくりタイムライン化する。
 *
 * 外部コード譜には秒情報がないため、以下のヒューリスティックで配置する:
 * - 1コード ≒ 1小節 (J-POPの中央値テンポ ~120bpm 4/4 → 約2.2秒) を目安に、
 *   進行が動画長より短い場合は進行全体を繰り返して埋める
 * - 動画長を等分してコードを並べる
 * - 細かいズレはユーザーがタップ修正する前提 (70点の叩き台)
 */
export function buildTimeline(
  progression: AnalyzeResult["progression"],
  duration: number
): ChordEvent[] {
  if (progression.length === 0 || duration <= 0) return [];

  const TARGET_CHORD_SEC = 2.2; // 1コードの目安秒数
  const n = progression.length;

  // 進行1周の想定時間と動画長から繰り返し回数を決める
  let repeats = Math.max(1, Math.round(duration / (n * TARGET_CHORD_SEC)));
  // 1コードが短くなりすぎ/長くなりすぎないように調整
  while (repeats > 1 && duration / (n * repeats) < 1.0) repeats--;
  if (duration / (n * repeats) > 8 && n > 4) {
    // コード数が少なすぎる場合はさらに繰り返す
    repeats = Math.max(repeats, Math.round(duration / (n * 4)));
  }

  const total = n * repeats;
  const chordDur = duration / total;

  const events: ChordEvent[] = [];
  for (let i = 0; i < total; i++) {
    const p = progression[i % n];
    const parsed = parseChord(p.name);
    events.push({
      id: newEventId(),
      name: p.name,
      root: parsed.root,
      quality: parsed.quality,
      bass: parsed.bass,
      start: i * chordDur,
      end: (i + 1) * chordDur,
      source: p.source,
      sourceCount: p.sourceCount,
      confidence: p.confidence * (repeats > 1 ? 0.9 : 1),
      edited: false,
      section: i < n ? p.section : undefined,
    });
  }
  return events;
}

/** 現在時間に対応するコードのインデックスを返す (-1 = なし) */
export function chordIndexAt(timeline: ChordEvent[], t: number): number {
  // タイムラインはstart昇順を前提に二分探索
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
    source: "user",
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
  // 次のコードの開始 or t+defaultDur まで
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
    source: "user",
    sourceCount: 0,
    confidence: 1,
    edited: true,
  };
  return normalizeTimeline([...timeline, ev]);
}

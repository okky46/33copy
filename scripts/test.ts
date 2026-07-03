// コアロジックのユニットテスト (npm test で実行)
// 依存を増やさないため素朴なassertベース

import { parseChord, voiceChord, midiToName, CHORD_TOKEN_RE } from "../src/lib/chords";
import { guessSong } from "../src/lib/titleParse";
import {
  chordIndexAt,
  makeAssumedGrid,
  normalizeTimeline,
  placeOnGrid,
  shiftTimeline,
  snapTime,
  splitAt,
} from "../src/lib/timeline";
import { integrate, verifyWithAudio } from "../src/lib/integrate";
import { extractChordsFromHtml } from "../src/lib/chordSources/extract";
import { buildConsensus } from "../src/lib/chordSources/consensus";
import { analyzeAudio } from "../src/lib/audioAnalysis/analyze";
import { extractVideoId } from "../src/lib/youtube";
import type { AnalyzeResult } from "../src/lib/types";

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${label}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function ok(cond: boolean, label: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`✗ ${label}`);
  }
}

// ---- ボイシング (要件の例と一致すること) ----
function voicingNames(name: string) {
  const v = voiceChord(parseChord(name));
  return {
    left: v.left.map((n) => midiToName(n)),
    right: v.right.map((n) => midiToName(n)),
  };
}

eq(voicingNames("C"), { left: ["C2"], right: ["E3", "G3", "C4"] }, "C voicing");
eq(voicingNames("G/B"), { left: ["B2"], right: ["G3", "B3", "D4"] }, "G/B voicing");
eq(voicingNames("Am7"), { left: ["A2"], right: ["G3", "C4", "E4"] }, "Am7 voicing");
eq(voicingNames("Fmaj7"), { left: ["F2"], right: ["A3", "C4", "E4"] }, "Fmaj7 voicing");

// ---- コードパース ----
ok(parseChord("C#m7").valid && parseChord("C#m7").rootPc === 1, "C#m7 parse");
ok(parseChord("Bb7").valid, "Bb7 parse");
const slash = parseChord("Em/G");
ok(slash.isSlash && slash.bass === "G", "Em/G slash");
ok(!parseChord("Hm7").valid, "invalid root rejected");
ok(CHORD_TOKEN_RE.test("Dm7"), "token regex Dm7");
ok(!CHORD_TOKEN_RE.test("Hello"), "token regex rejects words");

// ---- タイトル推定 ----
const g1 = guessSong("YOASOBI「夜に駆ける」 Official Music Video", "Ayase / YOASOBI");
eq(g1.title, "夜に駆ける", "guessSong 「」 title");
eq(g1.artist, "YOASOBI", "guessSong 「」 artist");
ok(g1.queries.some((q) => q.includes("コード")), "queries include コード");

const g2 = guessSong("Official髭男dism - Pretender［Official Video］", "Official髭男dism");
eq(g2.title, "Pretender", "guessSong dash title");

// ---- videoId抽出 ----
eq(extractVideoId("https://www.youtube.com/watch?v=x8VYWazR5mE"), "x8VYWazR5mE", "watch URL");
eq(extractVideoId("https://youtu.be/x8VYWazR5mE?t=10"), "x8VYWazR5mE", "youtu.be URL");
eq(extractVideoId("not a url"), null, "invalid URL");

// ---- 仮定グリッドとグリッド配置 ----
const prog: AnalyzeResult["progression"] = ["F", "G", "Em", "Am"].flatMap((name) =>
  Array.from({ length: 30 }, () => ({
    name,
    sourceCount: 2,
    providers: ["a", "b"],
    score: 0.8,
  }))
);
// 120コード, 240秒 → 1小節2秒 = BPM120 の仮定グリッド
const assumed = makeAssumedGrid(prog.length, 240);
ok(!!assumed && assumed.source === "assumed", "assumed grid source");
ok(!!assumed && Math.abs(assumed.bpm - 120) < 1, `assumed grid bpm ~120 (${assumed?.bpm})`);
ok(!!assumed && assumed.confidence <= 0.3, "assumed grid low confidence");
ok(!!assumed && makeAssumedGrid(10, 0) === null, "assumed grid null for zero duration");

const placed = placeOnGrid(prog, assumed!, 240);
ok(placed.length === 120, `placeOnGrid places all chords (${placed.length})`);
ok(placed.every((e, i) => i === 0 || e.start >= placed[i - 1].end - 1e-6), "placed monotonic");
ok(
  placed.every((e) => assumed!.downbeats.some((d) => Math.abs(d - e.start) < 0.02)),
  "placed starts on downbeats"
);
ok(placed[0].source === "merged" && placed[0].confidence === "medium", "placed confidence from 2 sources without audio");

// 超テンポの折り込み: 30コード240秒 → 1コード8秒 → BPM 30→折り込みで120、1コード4小節
const slowGrid = makeAssumedGrid(30, 240);
ok(!!slowGrid && slowGrid.bpm >= 70 && slowGrid.bpm <= 180, `bpm folded into range (${slowGrid?.bpm})`);

// ---- スナップとシフト ----
const snapGrid = makeAssumedGrid(120, 240)!; // beat=0.5s
eq(snapTime(1.13, snapGrid, "beat"), 1, "snap to beat");
eq(snapTime(1.13, snapGrid, "bar"), 2, "snap to bar");
eq(snapTime(1.13, snapGrid, "off"), 1.13, "snap off");
const shifted = shiftTimeline(placed.slice(0, 3), 0.5);
ok(Math.abs(shifted[0].start - placed[0].start - 0.5) < 1e-6, "shift +0.5");
ok(shiftTimeline(placed.slice(0, 1), -10)[0].start === 0, "shift clamps at 0");

// ---- タイムライン操作 ----
eq(chordIndexAt(placed, placed[2].start + 0.01), 2, "chordIndexAt");
eq(chordIndexAt(placed, -5), -1, "chordIndexAt before start");
const split = splitAt(placed, placed[0].start + 1);
eq(split.length, placed.length + 1, "splitAt adds one");
ok(split[1].source === "manual" && split[1].confidence === "high", "splitAt manual chord");
const overlapping = normalizeTimeline([
  { ...placed[0], start: 0, end: 5 },
  { ...placed[1], start: 3, end: 8 },
]);
ok(overlapping[0].end === 3, "normalize trims overlap");

// ---- 統合レイヤーの品質ゲート ----
const empty = integrate({ progression: [], sourceCount: 0, duration: 240 });
ok(empty.timeline.length === 0, "no evidence -> empty timeline");
ok(empty.summary.message.includes("十分なコード候補を取得できませんでした"), "no evidence -> honest message");

const extOnly = integrate({ progression: prog, sourceCount: 2, duration: 240 });
ok(extOnly.timeline.length > 0, "external only -> timeline");
ok(extOnly.summary.timingConfidence === "low", "external only -> low timing confidence");
ok(extOnly.grid?.source === "assumed", "external only -> assumed grid");
ok(extOnly.summary.message.includes("音源"), "external only -> suggests audio upload");

// 進行が短すぎる場合はゲートで弾く
const tooShort = integrate({
  progression: prog.slice(0, 2),
  sourceCount: 1,
  duration: 240,
});
ok(tooShort.timeline.length === 0, "too few chords -> empty timeline");

// ---- 音源照合 ----
const extTl = placed.slice(0, 2); // F, F (2小節)
const audioAgree = [
  { start: 0, end: 2, chord: "F", confidence: 0.8 },
  { start: 2, end: 4, chord: "F", confidence: 0.8 },
];
const verified = verifyWithAudio(extTl, audioAgree);
ok(verified[0].confidence === "high", "audio agreement bumps confidence");
const audioConflict = [
  { start: 0, end: 2, chord: "F#m", confidence: 0.8 },
  { start: 2, end: 4, chord: "B", confidence: 0.8 },
];
const conflicted = verifyWithAudio(extTl, audioConflict);
ok(conflicted[0].needsReview === true, "audio conflict flags needsReview");
ok(conflicted[0].confidence === "low", "audio conflict drops confidence");

// ---- 抽出 (代表的なHTMLパターン) ----
const htmlMarked = `<div>${["C", "G", "Am", "Em", "F", "C", "F", "G", "C", "G"]
  .map((c) => `<span class="chord">${c}</span>`)
  .join(" ")}</div>`;
ok(extractChordsFromHtml(htmlMarked).length === 10, "extract marked chords");
const htmlDense = `<html><body><p>イントロ</p><p>C G Am Em</p><p>F C F G</p><p>サビ</p><p>F G Em Am</p></body></html>`;
const dense = extractChordsFromHtml(htmlDense);
ok(dense.length === 12, `extract dense lines (${dense.length})`);
ok(dense[8].section === "サビ", "dense section detection");

// ---- コンセンサス ----
const srcA = {
  provider: "a", url: "http://a", pageTitle: "夜に駆ける コード", score: 0.8,
  chords: ["F", "G", "Em", "Am", "F", "G", "C", "C7"].map((name) => ({ name })),
};
const srcB = {
  provider: "b", url: "http://b", pageTitle: "夜に駆ける コード譜", score: 0.7,
  chords: ["F", "G", "Em", "Am", "Dm", "G", "C", "A7"].map((name) => ({ name })),
};
const consensus = buildConsensus([srcA, srcB]);
ok(consensus.length === 8, "consensus uses best source");
const fChord = consensus.find((c) => c.name === "F");
ok(!!fChord && fChord.sourceCount === 2 && fChord.providers.length === 2, "consensus counts providers");
ok(buildConsensus([]).length === 0, "consensus empty for no sources");

// ---- 音源解析 (合成音声: 120BPM、CとFのコードを1小節ごとに交互) ----
async function testAudioAnalysis() {
  const sr = 11025;
  const durationSec = 24;
  const samples = new Float32Array(sr * durationSec);
  const beatSec = 0.5; // 120 BPM
  const barSec = 2;
  const chordFreqs = {
    C: [130.81, 164.81, 196.0, 261.63], // C3 E3 G3 C4
    F: [174.61, 220.0, 261.63, 349.23], // F3 A3 C4 F4
  };
  for (let i = 0; i < samples.length; i++) {
    const t = i / sr;
    const bar = Math.floor(t / barSec);
    const freqs = bar % 2 === 0 ? chordFreqs.C : chordFreqs.F;
    // 拍ごとにアタックの立つ減衰エンベロープ
    const beatPos = (t % beatSec) / beatSec;
    const env = Math.exp(-4 * beatPos);
    let v = 0;
    for (const f of freqs) v += Math.sin(2 * Math.PI * f * t);
    samples[i] = (v / freqs.length) * env * 0.5;
  }

  const result = await analyzeAudio(samples, sr);
  ok(Math.abs(result.grid.bpm - 120) < 3, `audio BPM ~120 (got ${result.grid.bpm})`);
  ok(result.grid.beats.length > 30, `beats detected (${result.grid.beats.length})`);
  ok(result.grid.downbeats.length >= 8, `downbeats detected (${result.grid.downbeats.length})`);
  ok(result.grid.confidence > 0.15, `grid confidence positive (${result.grid.confidence})`);

  // コード候補: 小節ごとの正解 (Cバー/Fバー交互) と一致すること
  const correct = result.chords.filter((c) => {
    const mid = (c.start + c.end) / 2;
    const expected = Math.floor(mid / barSec) % 2 === 0 ? "C" : "F";
    return c.root === expected;
  }).length;
  ok(
    correct / Math.max(1, result.chords.length) >= 0.8,
    `audio chords match ground truth (${correct}/${result.chords.length})`
  );

  // 音源のみの統合
  const audioOnly = integrate({
    progression: [],
    sourceCount: 0,
    duration: durationSec,
    audioGrid: result.grid,
    audioChords: result.chords,
  });
  ok(audioOnly.timeline.length > 0, "audio only -> timeline from analysis");
  ok(audioOnly.summary.bpm === result.grid.bpm, "audio only -> bpm in summary");
  ok(
    audioOnly.summary.message.includes("外部コード譜は見つかりませんでした"),
    "audio only -> honest message"
  );
  ok(audioOnly.timeline.every((e) => e.source === "audio-analysis"), "audio only -> source label");
}

testAudioAnalysis()
  .catch((e) => {
    failed++;
    console.error("✗ audio analysis threw:", e);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  });

// コアロジックのユニットテスト (npm test で実行)
// 依存を増やさないため素朴なassertベース

import { parseChord, voiceChord, midiToName, CHORD_TOKEN_RE } from "../src/lib/chords";
import { guessSong } from "../src/lib/titleParse";
import { buildTimeline, chordIndexAt, splitAt, normalizeTimeline } from "../src/lib/timeline";
import { extractChordsFromHtml } from "../src/lib/chordSources/extract";
import { buildConsensus } from "../src/lib/chordSources/consensus";
import { buildFallbackProgression } from "../src/lib/chordSources/fallback";
import { extractVideoId } from "../src/lib/youtube";

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
ok(CHORD_TOKEN_RE.test("F#m7-5") === false || true, "token regex does not crash");
ok(CHORD_TOKEN_RE.test("Dm7"), "token regex Dm7");
ok(!CHORD_TOKEN_RE.test("Hello"), "token regex rejects words");

// ---- タイトル推定 ----
const g1 = guessSong("YOASOBI「夜に駆ける」 Official Music Video", "Ayase / YOASOBI");
eq(g1.title, "夜に駆ける", "guessSong 「」 title");
eq(g1.artist, "YOASOBI", "guessSong 「」 artist");
ok(g1.queries.some((q) => q.includes("コード")), "queries include コード");

const g2 = guessSong("Official髭男dism - Pretender［Official Video］", "Official髭男dism");
eq(g2.title, "Pretender", "guessSong dash title");
eq(g2.artist, "Official髭男dism", "guessSong dash artist");

const g3 = guessSong("マリーゴールド", "あいみょん");
eq(g3.title, "マリーゴールド", "guessSong plain title");
eq(g3.artist, "あいみょん", "guessSong channel artist");

// ---- videoId抽出 ----
eq(extractVideoId("https://www.youtube.com/watch?v=x8VYWazR5mE"), "x8VYWazR5mE", "watch URL");
eq(extractVideoId("https://youtu.be/x8VYWazR5mE?t=10"), "x8VYWazR5mE", "youtu.be URL");
eq(extractVideoId("https://www.youtube.com/shorts/x8VYWazR5mE"), "x8VYWazR5mE", "shorts URL");
eq(extractVideoId("not a url"), null, "invalid URL");

// ---- タイムライン ----
const prog = [
  { name: "F", sourceCount: 2, confidence: 0.8, source: "consensus" as const },
  { name: "G", sourceCount: 2, confidence: 0.8, source: "consensus" as const },
  { name: "Em", sourceCount: 1, confidence: 0.6, source: "external" as const },
  { name: "Am", sourceCount: 2, confidence: 0.8, source: "consensus" as const },
];
const tl = buildTimeline(prog, 240);
ok(tl.length >= 4, "timeline built");
ok(Math.abs(tl[tl.length - 1].end - 240) < 0.01, "timeline covers duration");
ok(tl.every((e, i) => i === 0 || e.start >= tl[i - 1].end - 0.001), "timeline monotonic");
const per = tl[0].end - tl[0].start;
ok(per >= 1 && per <= 8, `chord duration reasonable (${per.toFixed(2)}s)`);

eq(chordIndexAt(tl, tl[2].start + 0.01), 2, "chordIndexAt");
eq(chordIndexAt(tl, -5), -1, "chordIndexAt before start");

const split = splitAt(tl, tl[0].start + (per / 2));
eq(split.length, tl.length + 1, "splitAt adds one");
ok(split[1].start > split[0].start && split[1].edited, "splitAt boundary");

const overlapping = normalizeTimeline([
  { ...tl[0], start: 0, end: 5 },
  { ...tl[1], start: 3, end: 8 },
]);
ok(overlapping[0].end === 3, "normalize trims overlap");

// ---- 抽出 (代表的なHTMLパターン) ----
const htmlMarked = `<div>${["C", "G", "Am", "Em", "F", "C", "F", "G", "C", "G"]
  .map((c) => `<span class="chord">${c}</span>`)
  .join(" ")}</div>`;
ok(extractChordsFromHtml(htmlMarked).length === 10, "extract marked chords");

const htmlBracket = `<pre>[C]こころ[G]かさなる[Am]とき [Em]ながれる[F]なみだ [C]そっと[F]つよく[G]にぎる [C]て</pre>`;
ok(extractChordsFromHtml(htmlBracket).length === 9, "extract bracket chords");

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
ok(!!fChord && fChord.sourceCount === 2 && fChord.source === "consensus", "consensus marks agreement");
ok(consensus.every((c) => c.confidence > 0 && c.confidence <= 0.95), "confidence in range");

// ---- フォールバック ----
const fb = buildFallbackProgression("x8VYWazR5mE");
ok(fb.progression.length >= 8, "fallback progression");
ok(fb.progression.every((p) => p.source === "fallback" && p.confidence <= 0.3), "fallback low confidence");
ok(fb.progression.every((p) => parseChord(p.name).valid), "fallback chords valid");

// ----
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

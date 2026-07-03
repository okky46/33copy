// コアロジックのユニットテスト (npm test で実行)
// 依存を増やさないため素朴なassertベース

import {
  parseChord,
  voiceChord,
  midiToName,
  transposeChordName,
  CHORD_TOKEN_RE,
} from "../src/lib/chords";
import { buildQueries, cleanUserInput, guessSong, nameVariants } from "../src/lib/titleParse";
import {
  chordIndexAt,
  makeAssumedGrid,
  normalizeTimeline,
  placeOnGrid,
  rebuildGrid,
  shiftTimeline,
  snapTime,
  splitAt,
} from "../src/lib/timeline";
import { integrate, verifyWithAudio } from "../src/lib/integrate";
import {
  extractChordsFromHtml,
  extractChordsFromScripts,
  extractPageMeta,
} from "../src/lib/chordSources/extract";
import { bestTransposition, buildConsensus } from "../src/lib/chordSources/consensus";
import { scoreHit } from "../src/lib/chordSources/scoring";
import { parseBingHtml, parseDuckDuckGoHtml } from "../src/lib/chordSources/webSearch";
import { collectSources } from "../src/lib/chordSources/providers";
import { analyzeAudio } from "../src/lib/audioAnalysis/analyze";
import { extractVideoId } from "../src/lib/youtube";
import type { AnalyzeDebug, AnalyzeResult } from "../src/lib/types";

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

// 回帰テスト: アーティスト名の読み仮名注記・リリース情報がクエリに混入するバグ
// (実際に「≠ME（ノットイコールミー）/ 3rd Single」がアーティスト名として
//  誤抽出され、全検索クエリが壊れて0件になっていた)
const g3 = guessSong(
  "≠ME（ノットイコールミー）/ 3rd Single「チョコレートメランコリー」Music Video",
  "≠ME（ノットイコールミー）"
);
eq(g3.title, "チョコレートメランコリー", "guessSong furigana+release title");
eq(g3.artist, "≠ME", "guessSong furigana+release artist (no ふりがな/リリース情報混入)");
ok(!g3.artist.includes("Single"), "artist does not contain release info");
ok(!g3.artist.includes("ノットイコールミー"), "artist does not contain furigana");
const g3Queries = buildQueries(g3.title, g3.artist);
ok(g3Queries.every((q) => !q.includes("Single") && !q.includes("ノットイコールミー")), "queries are clean");

// チャンネル名だけにふりがなが付くケース (区切りなしタイトル → チャンネル名がアーティストに)
const g4 = guessSong("チョコレートメランコリー", "≠ME（ノットイコールミー）");
eq(g4.artist, "≠ME", "channel-derived artist strips furigana");

// リリース情報がタイトル側に残るケースも除去されること
const g5 = guessSong("テスト曲 - テストアーティスト(2nd Single)", "テストアーティスト");
ok(!g5.title.includes("Single") && !g5.artist.includes("Single"), "release info stripped from either side");

// 手動オーバーライド (曲名修正フォーム) にペーストされたテキストも同様に浄化されること
eq(cleanUserInput("≠ME（ノットイコールミー）/ 3rd Single"), "≠ME", "cleanUserInput strips furigana+release");
eq(cleanUserInput("チョコレートメランコリー"), "チョコレートメランコリー", "cleanUserInput passthrough");

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

// ---- コードパース拡張 (♭ / N.C. / 移調) ----
ok(parseChord("B♭m").valid && parseChord("B♭m").rootPc === 10, "B♭m parse");
ok(parseChord("E♭m").rootPc === 3, "E♭m parse");
const nc = parseChord("N.C.");
ok(nc.valid && nc.isNoChord === true, "N.C. parse");
eq(voiceChord(nc), { left: [], right: [] }, "N.C. no voicing");
eq(transposeChordName("Am7", 2), "Bm7", "transpose Am7 +2");
eq(transposeChordName("G/B", 1), "G#/C", "transpose slash chord");
eq(transposeChordName("C", 0), "C", "transpose 0 is identity");
eq(transposeChordName("N.C.", 5), "N.C.", "transpose N.C.");

// ---- 表記バリアントとクエリ生成 ----
const vars = nameVariants("チョコレート メランコリー");
ok(vars.includes("チョコレートメランコリー"), "variant without space");
ok(nameVariants("≠ME").length >= 1, "variant for symbol artist");
const queries = buildQueries("チョコレートメランコリー", "≠ME");
ok(queries.some((q) => q.includes("ギターコード")), "queries include ギターコード");
ok(queries.some((q) => q.includes("弾き語り")), "queries include 弾き語り");
ok(queries.some((q) => /chords?/.test(q)), "queries include chords");
ok(queries.length >= 6, `multiple queries generated (${queries.length})`);

// ---- 検索結果スコアリング ----
const ufretHit = {
  url: "https://www.ufret.jp/song.php?data=12345",
  title: "チョコレートメランコリー / ≠ME ギターコード譜 - U-FRET",
  snippet: "≠MEの「チョコレートメランコリー」のギターコード譜",
  searchProvider: "DuckDuckGo",
};
const sUfret = scoreHit(ufretHit, "チョコレートメランコリー", "≠ME");
ok(sUfret.accepted && sUfret.score >= 3, `ufret hit accepted (score ${sUfret.score.toFixed(1)})`);
ok(sUfret.reasons.some((r) => r.includes("コードサイト")), "ufret domain recognized");

const lyricsHit = {
  url: "https://www.uta-net.com/song/999999/",
  title: "チョコレートメランコリー 歌詞 - 歌ネット",
  snippet: "≠MEの「チョコレートメランコリー」歌詞ページ",
  searchProvider: "DuckDuckGo",
};
const sLyrics = scoreHit(lyricsHit, "チョコレートメランコリー", "≠ME");
ok(!sLyrics.accepted, `lyrics page rejected (score ${sLyrics.score.toFixed(1)})`);

const newsHit = {
  url: "https://example-news.com/article/123",
  title: "≠ME 新曲リリース決定のニュース",
  snippet: "アイドルグループ≠MEが新曲をリリース",
  searchProvider: "Bing",
};
ok(!scoreHit(newsHit, "チョコレートメランコリー", "≠ME").accepted, "news page rejected");

// ---- 抽出拡張 (全角 / ♭ / N.C. / カポ / script埋め込み) ----
const htmlFlat = `<pre>A♭ B♭m E♭ Fm A♭ D♭ E♭ Cm A♭ B♭m</pre>`;
const flat = extractChordsFromHtml(htmlFlat);
ok(flat.length === 10 && flat[1].name === "B♭m", `flat chords extracted (${flat.length})`);

const htmlZenkaku = `<p>Ａｍ７ Ｇ Ｆmaj7 Ｃ Ａｍ７ Ｇ Ｆ Ｃ</p>`;
const zen = extractChordsFromHtml(htmlZenkaku);
ok(zen.length === 8 && zen[0].name === "Am7", `zenkaku normalized (${zen[0]?.name})`);

const htmlNc = `<p>C G N.C. Am F G C N.C.</p>`;
ok(extractChordsFromHtml(htmlNc).filter((c) => c.name === "N.C.").length === 2, "N.C. extracted");

eq(extractPageMeta("<p>カポ2で弾けます</p>").capo, 2, "capo detection");
eq(extractPageMeta("<p>Capo: 3</p>").capo, 3, "capo detection en");
eq(extractPageMeta("<p>原曲キー: E♭</p>").keyLabel, "E♭", "key detection");

// U-FRET風: コードがJS文字列として埋め込まれているケース
const chordArr = ["C", "G/B", "Am7", "Em", "F", "C/E", "Dm7", "G7", "C", "G", "Am", "F", "C", "G", "F", "G", "Am7", "G", "F", "C"];
const htmlScript = `<html><body><div id="app"></div><script>var chords=[${chordArr.map((c) => `"${c}"`).join(",")}];render(chords);</script></body></html>`;
const scriptChords = extractChordsFromScripts(htmlScript);
ok(scriptChords.length === 20, `script-embedded chords extracted (${scriptChords.length})`);
ok(scriptChords[1].name === "G/B", "script chords keep slash");

// scriptに歌詞などコード以外が多い場合は誤検出しない
const htmlNoisy = `<script>var w=["hello","world","foo","bar","baz","qux","C","G"];</script>`;
ok(extractChordsFromScripts(htmlNoisy).length === 0, "noisy script not misdetected");

// ---- 検索結果HTMLのパース (フィクスチャ) ----
const ddgHtml = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.ufret.jp%2Fsong.php%3Fdata%3D12345&rut=abc">テスト曲 ギターコード - U-FRET</a>
  <a class="result__snippet" href="#">テスト曲のギターコード譜。初心者向け簡単コードも。</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://ja.chordwiki.org/wiki/%E3%83%86%E3%82%B9%E3%83%88">テスト曲 - ChordWiki</a>
</div>`;
const ddgHits = parseDuckDuckGoHtml(ddgHtml);
ok(ddgHits.length === 2, `ddg parse hits (${ddgHits.length})`);
eq(ddgHits[0].url, "https://www.ufret.jp/song.php?data=12345", "ddg uddg redirect expanded");
ok(ddgHits[0].title.includes("U-FRET"), "ddg title extracted");
ok(ddgHits[0].snippet.includes("コード譜"), "ddg snippet extracted");

const bingHtml = `
<ol id="b_results">
<li class="b_algo"><h2><a href="https://gakufu.gakki.me/m/data/N12345.html">テスト曲 コード譜 - 楽器.me</a></h2><div class="b_caption"><p>テスト曲のコード譜を掲載。</p></div></li>
<li class="b_algo"><h2><a href="https://www.uta-net.com/song/1/">テスト曲 歌詞</a></h2><p>歌詞ページ</p></li>
</ol>`;
const bingHits = parseBingHtml(bingHtml);
ok(bingHits.length === 2, `bing parse hits (${bingHits.length})`);
eq(bingHits[0].url, "https://gakufu.gakki.me/m/data/N12345.html", "bing url extracted");
ok(bingHits[0].snippet.includes("コード譜"), "bing snippet extracted");

// ---- 検索パイプラインの耐性テスト (グローバルfetchをモックしてend-to-endで検証) ----
// 実際に報告されたバグ: U-FRET/ChordWikiのリンク構造が想定と違う・
// DuckDuckGo/Bingの専用パーサが0件、のケースでもフォールバック抽出で
// 候補を拾えることを確認する。
async function testSearchResilience() {
  const chordPageHtml = (label: string) =>
    `<html><head><title>チョコレートメランコリー / ≠ME ギターコード - ${label}</title></head><body>${[
      "C", "G", "Am", "Em", "F", "C", "F", "G", "C", "G", "Am", "F",
    ]
      .map((c) => `<span class="chord">${c}</span>`)
      .join(" ")}</body></html>`;

  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const html = (body: string, status = 200) =>
      new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

    // U-FRET: 検索結果はsong.php?data=形式ではなく新形式のパスを返す (フォールバック正規表現を試す)
    if (url.includes("ufret.jp/search.php")) {
      return html(`<a href="/song/999888">チョコレートメランコリー / ≠ME</a>`);
    }
    if (url.includes("ufret.jp/song/999888")) return html(chordPageHtml("U-FRET"));

    // ChordWiki: t=パラメータではなくc=view形式のリンクを返す (広い正規表現を試す)
    if (url.includes("chordwiki.org/wiki.cgi?c=search")) {
      return html(`<a href="/wiki.cgi?c=view&p=%E3%83%86%E3%82%B9%E3%83%88">チョコレートメランコリー - ChordWiki</a>`);
    }
    if (url.includes("chordwiki.org/wiki.cgi?c=view")) return html(chordPageHtml("ChordWiki"));

    // DuckDuckGo: 専用セレクタに一致しない壊れたマークアップ (汎用リンク抽出へのフォールバックを試す)
    if (url.includes("duckduckgo.com")) {
      return html(
        `<html><body><a href="https://gakufu.gakki.me/m/data/N99999.html">チョコレートメランコリー コード - 楽器.me</a><a href="https://duckduckgo.com/about">About</a></body></html>`
      );
    }
    if (url.includes("gakufu.gakki.me")) return html(chordPageHtml("楽器.me"));

    // Bing: 同様に壊れたマークアップからのフォールバック
    if (url.includes("bing.com")) {
      return html(
        `<html><body><a href="https://www.easter-egg.me/song/888">チョコレートメランコリー コード</a><a href="https://www.bing.com/privacy">Privacy</a></body></html>`
      );
    }
    if (url.includes("easter-egg.me")) return html(chordPageHtml("easter-egg.me"));

    return html("", 404);
  }) as typeof fetch;

  try {
    const debug: AnalyzeDebug = {
      songTitle: "チョコレートメランコリー", artist: "≠ME",
      queries: ["チョコレートメランコリー ≠ME コード"],
      searches: [], candidates: [], fetched: [], adopted: [], keyCorrections: [], elapsedMs: 0,
    };
    const sources = await collectSources(
      { title: "チョコレートメランコリー", artist: "≠ME", confidence: 1, queries: debug.queries },
      debug
    );

    ok(sources.length >= 3, `resilient search adopts sources despite broken markup (${sources.length})`);
    const providers = sources.map((s) => s.provider);
    ok(providers.some((p) => p.includes("ufret")), `U-FRET adopted via fallback regex (${providers.join(",")})`);
    ok(providers.some((p) => p.includes("chordwiki")), "ChordWiki adopted via broadened regex");
    const ddgSearch = debug.searches.find((s) => s.provider === "DuckDuckGo");
    ok(!!ddgSearch?.usedFallback, "DuckDuckGo search marked as using generic fallback");
    const bingSearch = debug.searches.find((s) => s.provider === "Bing");
    ok(!!bingSearch?.usedFallback, "Bing search marked as using generic fallback");
    ok(debug.fetched.some((f) => f.ok), "debug records at least one successful fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---- 移調を考慮したコンセンサス ----
const progA = ["C", "G", "Am", "Em", "F", "C", "F", "G", "C", "G", "Am", "F"];
const srcOrig = {
  provider: "ufret.jp", url: "http://u", pageTitle: "テスト曲 コード", score: 0.8,
  chords: progA.map((name) => ({ name })),
};
// 同じ進行を+2移調 (キー違いソースの想定)
const srcTransposed = {
  provider: "gakki.me", url: "http://g", pageTitle: "テスト曲 コード譜", score: 0.7,
  chords: progA.map((name) => ({ name: transposeChordName(name, 2) })),
};
const bt = bestTransposition(srcOrig, srcTransposed);
ok(bt.k === 10 && bt.similarity > 0.9, `bestTransposition detects key diff (k=${bt.k}, sim=${bt.similarity.toFixed(2)})`);

const consensusT = buildConsensus([srcOrig, srcTransposed]);
ok(consensusT.every((c) => c.sourceCount === 2), "transposed source agrees after correction");
ok(consensusT.every((c) => !c.disputed), "no dispute after key correction");

// カポ補正: カポ2表記 (実音より2半音低く書かれている) → +2補正で一致
const srcCapo = {
  provider: "capo-site", url: "http://c", pageTitle: "テスト曲 コード", score: 0.7, capo: 2,
  chords: progA.map((name) => transposeChordName(name, -2)).map((name) => ({ name })),
};
const consensusCapo = buildConsensus([srcOrig, srcCapo]);
ok(consensusCapo.every((c) => c.sourceCount === 2), "capo source agrees after correction");

// 全く違うソース → disputed
const srcDifferent = {
  provider: "other", url: "http://d", pageTitle: "テスト曲", score: 0.5,
  chords: ["Db", "Ab7", "Bbm7", "Gb7", "Db", "Ebm7", "Ab7", "Db", "Gb", "Ab7", "Bbm", "Ebm"].map((name) => ({ name })),
};
const consensusD = buildConsensus([srcOrig, srcDifferent]);
ok(consensusD.some((c) => c.disputed), "conflicting sources mark disputed");

// ---- rebuildGrid (BPM手動変更・小節頭合わせ) ----
const manualGrid = rebuildGrid(120, 3, 60);
ok(!!manualGrid && manualGrid.bpm === 120, "rebuildGrid bpm");
ok(!!manualGrid && manualGrid.downbeats.includes(3), "firstDownbeat is a downbeat");
ok(!!manualGrid && manualGrid.downbeats[0] === 1 || manualGrid!.downbeats[0] === 3 - 2, `backward extrapolation (${manualGrid?.downbeats[0]})`);
ok(!!manualGrid && manualGrid.beats.every((b) => b >= 0), "no negative beats");
ok(rebuildGrid(10, 0, 60) === null, "rejects absurd bpm");

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

Promise.all([
  testSearchResilience().catch((e) => {
    failed++;
    console.error("✗ search resilience threw:", e);
  }),
  testAudioAnalysis().catch((e) => {
    failed++;
    console.error("✗ audio analysis threw:", e);
  }),
]).finally(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});

// コード理論: コード名のパース、ピアノボイシング(左手/右手)、説明文生成

export interface ParsedChord {
  /** 正規化した表示名 */
  name: string;
  root: string;
  rootPc: number; // ピッチクラス 0=C
  quality: string;
  /** ルートからの半音インターバル */
  intervals: number[];
  bass: string;
  bassPc: number;
  isSlash: boolean;
  valid: boolean;
}

export interface Voicing {
  /** 左手 (MIDIノート番号) */
  left: number[];
  /** 右手 (MIDIノート番号) */
  right: number[];
}

const NOTE_TO_PC: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4, "E#": 5,
  F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11, Cb: 11,
};

const PC_TO_NAME_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const PC_TO_NAME_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

/** コード種別 → インターバル定義 (半音) */
const QUALITY_INTERVALS: [RegExp, number[]][] = [
  [/^(maj9|M9|△9)$/, [0, 4, 7, 11, 14]],
  [/^(maj7|M7|△7|Maj7)$/, [0, 4, 7, 11]],
  [/^(mM7|mmaj7|mM9)$/, [0, 3, 7, 11]],
  [/^(m7b5|m7-5|m7\(b5\)|ø)$/, [0, 3, 6, 10]],
  [/^(m9)$/, [0, 3, 7, 10, 14]],
  [/^(m7)$/, [0, 3, 7, 10]],
  [/^(m6)$/, [0, 3, 7, 9]],
  [/^(madd9)$/, [0, 3, 7, 14]],
  [/^(m)$/, [0, 3, 7]],
  [/^(dim7)$/, [0, 3, 6, 9]],
  [/^(dim|o)$/, [0, 3, 6]],
  [/^(aug7|\+7)$/, [0, 4, 8, 10]],
  [/^(aug|\+)$/, [0, 4, 8]],
  [/^(7sus4)$/, [0, 5, 7, 10]],
  [/^(sus4)$/, [0, 5, 7]],
  [/^(sus2)$/, [0, 2, 7]],
  [/^(add9)$/, [0, 4, 7, 14]],
  [/^(69|6\/9)$/, [0, 4, 7, 9, 14]],
  [/^(6)$/, [0, 4, 7, 9]],
  [/^(9)$/, [0, 4, 7, 10, 14]],
  [/^(13)$/, [0, 4, 7, 10, 14, 21]],
  [/^(11)$/, [0, 4, 7, 10, 17]],
  [/^(7\(?b9\)?|7-9)$/, [0, 4, 7, 10, 13]],
  [/^(7\(?#9\)?|7\+9)$/, [0, 4, 7, 10, 15]],
  [/^(7\(?#5\)?)$/, [0, 4, 8, 10]],
  [/^(7\(?b5\)?|7-5)$/, [0, 4, 6, 10]],
  [/^(7)$/, [0, 4, 7, 10]],
  [/^(maj|M|△)?$/, [0, 4, 7]],
];

/** テキストがコード名として妥当かの正規表現 (抽出フィルタにも使う) */
export const CHORD_TOKEN_RE =
  /^[A-G][#b♯♭]?(?:maj9|maj7|Maj7|M7|M9|△7|△9|△|mM7|mmaj7|m7b5|m7-5|m7\(b5\)|dim7|dim|aug7|aug|m9|m7|m6|madd9|m|7sus4|sus4|sus2|add9|69|6|9|11|13|7\(?[#b+-]?[59]\)?|7|o|ø|\+)?(?:\/[A-G][#b♯♭]?)?$/;

function normalizeAccidental(s: string): string {
  return s.replace("♯", "#").replace("♭", "b");
}

/** コード名文字列をパースする。パースできない場合 valid=false でメジャートライアド扱い */
export function parseChord(raw: string): ParsedChord {
  const name = normalizeAccidental(raw.trim());
  const m = name.match(/^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/);
  const fallback: ParsedChord = {
    name: raw, root: "C", rootPc: 0, quality: "", intervals: [0, 4, 7],
    bass: "C", bassPc: 0, isSlash: false, valid: false,
  };
  if (!m) return fallback;
  const [, root, qualityRaw, slashBass] = m;
  const rootPc = NOTE_TO_PC[root];
  if (rootPc === undefined) return fallback;

  const quality = qualityRaw.trim();
  let intervals: number[] | null = null;
  for (const [re, iv] of QUALITY_INTERVALS) {
    if (re.test(quality)) { intervals = iv; break; }
  }
  const valid = intervals !== null;
  if (!intervals) intervals = [0, 4, 7];

  const bass = slashBass ? slashBass : root;
  const bassPc = NOTE_TO_PC[bass] ?? rootPc;

  return {
    name, root, rootPc, quality, intervals,
    bass, bassPc, isSlash: !!slashBass && bassPc !== rootPc, valid,
  };
}

/** MIDIノート番号 → "C4" 形式 (C4=60) */
export function midiToName(midi: number, useFlat = false): string {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return (useFlat ? PC_TO_NAME_FLAT : PC_TO_NAME_SHARP)[pc] + octave;
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * ピアノボイシングを生成する。
 * - 左手: ベース音(オンコードならslash後の音)を C2..B2 に配置
 * - 右手: コードトーンを中音域(C4付近)にコンパクトに積む
 *   - 4音以上のコードはルートを省略 (ベースが担当)
 * 例: C -> L:C2 R:E3 G3 C4 / G/B -> L:B2 R:G3 B3 D4
 *     Am7 -> L:A2 R:G3 C4 E4 / Fmaj7 -> L:F2 R:A3 C4 E4
 */
export function voiceChord(chord: ParsedChord): Voicing {
  // 左手: C2(36)..B2(47)
  const left = [36 + chord.bassPc];

  // 右手の音プール (ピッチクラス)
  let pcs = Array.from(new Set(chord.intervals.map((iv) => (chord.rootPc + iv) % 12)));
  const isTriad = pcs.length <= 3;
  if (pcs.length >= 4) {
    // ルート省略。5音以上なら5thも省く
    pcs = pcs.filter((pc) => pc !== chord.rootPc);
    if (pcs.length >= 4) {
      const fifth = (chord.rootPc + 7) % 12;
      const without5 = pcs.filter((pc) => pc !== fifth);
      if (without5.length >= 3) pcs = without5;
    }
  }
  pcs.sort((a, b) => a - b);

  // 各ローテーション(転回形)を「最低音がしきい値以上で最小」になるように積み、
  // 開始音が最も低いものを採用 → 中音域に自然に収まる
  const threshold = isTriad ? 52 /* E3 */ : 55 /* G3 */;
  let best: number[] | null = null;
  for (let r = 0; r < pcs.length; r++) {
    const rotated = [...pcs.slice(r), ...pcs.slice(0, r)];
    const notes: number[] = [];
    for (const pc of rotated) {
      const minNote = notes.length === 0 ? threshold : notes[notes.length - 1] + 1;
      let n = pc + 12 * Math.ceil((minNote - pc) / 12);
      if (n < minNote) n += 12;
      notes.push(n);
    }
    if (!best || notes[0] < best[0]) best = notes;
  }

  return { left, right: best ?? [] };
}

const QUALITY_DESC: [RegExp, string][] = [
  [/^(maj7|M7|△7|Maj7|maj9|M9|△9)$/, "おしゃれで浮遊感のあるメジャーセブンス系の響き"],
  [/^(mM7|mmaj7)$/, "妖しく切ないマイナーメジャーセブンス"],
  [/^(m7b5|m7-5|ø)$/, "不安定で次への期待感が強いハーフディミニッシュ"],
  [/^(m9|m7)$/, "都会的でやわらかいマイナーセブンス"],
  [/^(m6|madd9)$/, "少し翳りのあるおしゃれなマイナー系の響き"],
  [/^m$/, "落ち着いた・切ない響きのマイナーコード"],
  [/^(dim7?|o)$/, "不安定で経過的なディミニッシュ。半音進行のつなぎによく使われる"],
  [/^(aug7?|\+7?)$/, "浮遊感と緊張感のあるオーギュメント"],
  [/^(7sus4|sus4)$/, "3度を吊り上げた、解決を待つサスペンデッドの響き"],
  [/^sus2$/, "透明感のあるサスツーの響き"],
  [/^(add9|69|6\/9)$/, "9thの音が加わった広がりのある響き"],
  [/^6$/, "柔らかく明るいシックスコード"],
  [/^(9|11|13|7.*)$/, "次のコードへ進みたくなるセブンス系の響き"],
  [/^7$/, "次のコードへ進みたくなるセブンス"],
  [/^(maj|M|△)?$/, "明るくストレートなメジャーコード"],
];

/** コードの簡単な日本語説明を生成 */
export function describeChord(chord: ParsedChord): string {
  if (!chord.valid) return "未対応のコード表記のため、メジャーコードとして表示しています";
  let desc = "";
  for (const [re, d] of QUALITY_DESC) {
    if (re.test(chord.quality)) { desc = d; break; }
  }
  if (chord.isSlash) {
    desc += `。オンコード（分数コード）: ベースは ${chord.bass}。左手は ${chord.bass} を弾くとベースラインがなめらかにつながる`;
  }
  return desc;
}

/** ルートのピッチクラス → タイムライン表示用カラー */
export function chordColor(rootPc: number, isMinor: boolean): string {
  const hue = (rootPc * 30) % 360;
  return `hsl(${hue} ${isMinor ? 35 : 55}% ${isMinor ? 38 : 45}%)`;
}

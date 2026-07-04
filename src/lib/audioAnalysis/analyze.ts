// 音源解析: BPM・拍位置・小節頭・chroma・コード候補・ベース音候補を推定する
//
// 完璧な自動採譜は目的ではない。少なくともBPMと拍・小節グリッドを取り、
// コード候補は「ユーザーがすぐ直せる叩き台」の品質を目指す。
// 純粋なTS実装 (Web Audio非依存) なので、Nodeでのテストとブラウザ実行を共用できる。
//
// 実音源 (ドラム・ボーカル・残響を含むミックス) での精度を上げるため、以下を行う:
// - 低音域でも半音を区別できるよう大きめのFFT (4096) を使う
// - ビン周波数が2つのピッチクラスの間にある場合は按分して両方に加算する
//   (低音域ほどビン幅が半音間隔に対して相対的に広いため、丸め誤差を減らす)
// - 振幅の対数圧縮 (log1p) でボーカルや打楽器の突出したピークの影響を弱める
// - 時間方向のメディアンフィルタでドラム等の瞬間的な非調性成分を抑える
//   (harmonic-percussive分離の簡易近似)
// - 小節を基本単位としてコードを推定する (多くのJ-POPは1小節1コードで進行するため)。
//   前半/後半で明確に異なるコードが鳴っている場合のみ半小節に分割する。
//   拍単位まで細かく判定すると、ノイズによる誤検出で逆に精度が落ちるため、
//   分割は「小節→半小節」の1段階のみに留める
// - メジャー/マイナー3和音だけでなく7th/6th/sus/dim/augもテンプレートに含める

import { FFT, hannWindow } from "./fft";
import type { AudioAnalysisResult, AudioChordCandidate, BeatGrid } from "../types";

const CHROMA_FFT_SIZE = 4096;
const HOP_SIZE = 512;
const MIN_BPM = 60;
const MAX_BPM = 200;

/** chroma集計に使う周波数帯。上限を4kHzではなく2.5kHzに抑え、
 *  ボーカルの高次倍音やシンバル等の非調性ノイズの混入を減らす */
const CHROMA_MIN_FREQ = 55;
const CHROMA_MAX_FREQ = 2500;
const BASS_MAX_FREQ = 260;

/** 打楽器抑制 (簡易HPSS) の窓半径。時間方向は持続音の平滑化、周波数方向は
 *  「特定ビンだけ突出=調性音」「広帯域にわたって同程度=打楽器音」を判別するために使う */
const MEDIAN_RADIUS_TIME = 4;
const MEDIAN_RADIUS_FREQ = 6;

const PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export interface AnalyzeOptions {
  /** 進捗コールバック 0..1 */
  onProgress?: (ratio: number) => void;
  /** UIをブロックしないための譲歩関数 (ブラウザでは setTimeout(0) 等) */
  yieldFn?: () => Promise<void>;
}

interface Frames {
  novelty: Float32Array;
  chroma: Float32Array[]; // frame -> 12
  bassChroma: Float32Array[];
  energy: Float32Array;
  hopSec: number;
  /** フレームiの中心時刻 = i*hopSec + centerOffset。
   *  noveltyのピークはフレーム中心がアタック位置に一致する */
  centerOffset: number;
}

/**
 * モノラル音声サンプルを解析する。
 * sampleRate は 8000〜22050 程度を想定 (呼び出し側でダウンサンプル推奨)。
 */
export async function analyzeAudio(
  samples: Float32Array,
  sampleRate: number,
  opts: AnalyzeOptions = {}
): Promise<AudioAnalysisResult> {
  const duration = samples.length / sampleRate;
  const frames = await computeFrames(samples, sampleRate, opts);
  opts.onProgress?.(0.85);

  const tempo = estimateTempo(frames.novelty, frames.hopSec);
  const acfProminence = tempo.acfProminence;
  let bpm = tempo.bpm;
  let periodFrames = tempo.periodFrames;
  // テンポのオクターブ補正: 速すぎる推定 (>150BPM) は倍テンポを拾っている可能性が高い。
  // その場合「1小節」が実質2拍になり、半小節分割が1拍刻みに見えてしまうため、
  // 拍を1つおきに間引いて実テンポ帯 (75BPM相当) に寄せ、小節=4拍が音楽的な
  // 1小節に対応するようにする。
  if (bpm > 150) {
    periodFrames *= 2;
    bpm /= 2;
  }
  const { beats, phaseContrast } = findBeats(frames, periodFrames, duration);
  const { downbeats, firstDownbeat } = findDownbeats(beats, frames);
  opts.onProgress?.(0.92);

  const key = estimateKey(frames);
  const gridConfidence = clamp01(((phaseContrast - 1) * 1.6 + (acfProminence - 1.1) * 0.8) / 2);
  const grid: BeatGrid = {
    bpm: Math.round(bpm * 10) / 10,
    beats: beats.map(round3),
    downbeats: downbeats.map(round3),
    firstDownbeat: round3(firstDownbeat),
    confidence: round3(gridConfidence),
    source: "audio",
  };

  const chords = detectChordsPerBar(grid, frames, duration, key.bias);
  opts.onProgress?.(1);

  return { grid, chords, duration, key: { tonicPc: key.tonicPc, mode: key.mode, confidence: round3(key.confidence) } };
}

/**
 * STFTを複数パスで処理してフレームごとの novelty / chroma / bass chroma / energy を計算する。
 * 1. 全ビンの振幅からnovelty/energyを求めつつ、対象帯域ビンの振幅時系列を保存する
 * 2. 簡易HPSS (harmonic-percussive分離) で打楽器的な瞬間成分を抑える:
 *    - 時間方向メディアン → 持続音を残す「調性成分」の目安 (harmonicEnhanced)
 *    - 周波数方向メディアン → 広帯域に均される「打楽器成分」の目安 (percussiveEnhanced)
 *    - 両者の二乗比からソフトマスクを作り元の振幅に掛けることで、
 *      大きめのFFT窓 (周波数分解能重視) を使っても打楽器の瞬間的なエネルギーが
 *      多数のフレームに滲み出す問題を、フレーム単位の「尖り具合」で判別して抑える
 * 3. フィルタ後の振幅を対数圧縮し、隣接2ピッチクラスへ按分してchroma/bassChromaを作る
 */
async function computeFrames(
  samples: Float32Array,
  sampleRate: number,
  opts: AnalyzeOptions
): Promise<Frames> {
  const N = CHROMA_FFT_SIZE;
  const fft = new FFT(N);
  const window = hannWindow(N);
  const nFrames = Math.max(0, Math.floor((samples.length - N) / HOP_SIZE) + 1);
  const hopSec = HOP_SIZE / sampleRate;
  const nBins = N / 2;

  // ビンごとの対象帯域判定と、按分先の2ピッチクラス・重みを事前計算する
  const binPcA = new Int8Array(nBins).fill(-1);
  const binWA = new Float32Array(nBins);
  const binPcB = new Int8Array(nBins).fill(-1);
  const binWB = new Float32Array(nBins);
  const binIsBass = new Uint8Array(nBins);
  const inRangeBins: number[] = [];
  for (let k = 1; k < nBins; k++) {
    const freq = (k * sampleRate) / N;
    if (freq < CHROMA_MIN_FREQ || freq > CHROMA_MAX_FREQ) continue;
    inRangeBins.push(k);
    if (freq <= BASS_MAX_FREQ) binIsBass[k] = 1;
    const midi = 69 + 12 * Math.log2(freq / 440);
    const pcFloat = ((midi % 12) + 12) % 12;
    const lower = Math.floor(pcFloat);
    const frac = pcFloat - lower;
    binPcA[k] = lower % 12;
    binWA[k] = 1 - frac;
    binPcB[k] = (lower + 1) % 12;
    binWB[k] = frac;
  }

  // --- Pass 1: STFT ---
  const magByBin: Float32Array[] = inRangeBins.map(() => new Float32Array(nFrames));
  const novelty = new Float32Array(nFrames);
  const energy = new Float32Array(nFrames);

  const buf = new Float32Array(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const power = new Float32Array(nBins);
  const prevMag = new Float32Array(nBins);
  const curMag = new Float32Array(nBins);

  for (let f = 0; f < nFrames; f++) {
    const offset = f * HOP_SIZE;
    for (let i = 0; i < N; i++) buf[i] = samples[offset + i] * window[i];
    fft.powerSpectrum(buf, re, im, power);

    let flux = 0;
    let en = 0;
    for (let k = 1; k < nBins; k++) {
      const mag = Math.sqrt(power[k]);
      curMag[k] = mag;
      en += power[k];
      // 対数圧縮したフラックス: 大きな打楽器的トランジェントに支配されにくくする
      const d = Math.log1p(mag) - Math.log1p(prevMag[k]);
      if (d > 0) flux += d;
      prevMag[k] = mag;
    }
    novelty[f] = flux;
    energy[f] = en;

    for (let idx = 0; idx < inRangeBins.length; idx++) {
      magByBin[idx][f] = curMag[inRangeBins[idx]];
    }

    if (f % 200 === 199) {
      opts.onProgress?.(0.5 * (f / nFrames));
      if (opts.yieldFn) await opts.yieldFn();
    }
  }

  // --- Pass 2a: 時間方向メディアン (harmonic-enhanced: 持続音を残す) ---
  const nBinsInRange = inRangeBins.length;
  const harmEnh: Float32Array[] = inRangeBins.map(() => new Float32Array(nFrames));
  {
    const win = new Float32Array(MEDIAN_RADIUS_TIME * 2 + 1);
    for (let idx = 0; idx < nBinsInRange; idx++) {
      const src = magByBin[idx];
      const dst = harmEnh[idx];
      for (let f = 0; f < nFrames; f++) {
        const lo = Math.max(0, f - MEDIAN_RADIUS_TIME);
        const hi = Math.min(nFrames - 1, f + MEDIAN_RADIUS_TIME);
        const len = hi - lo + 1;
        for (let i = 0; i < len; i++) win[i] = src[lo + i];
        dst[f] = medianOf(win, len);
      }
      if (idx % 100 === 99) {
        opts.onProgress?.(0.5 + 0.15 * (idx / nBinsInRange));
        if (opts.yieldFn) await opts.yieldFn();
      }
    }
  }

  // --- Pass 2b: 周波数方向メディアン (percussive-enhanced: 広帯域成分を残す) ---
  const percEnh: Float32Array[] = inRangeBins.map(() => new Float32Array(nFrames));
  {
    const win = new Float32Array(MEDIAN_RADIUS_FREQ * 2 + 1);
    for (let f = 0; f < nFrames; f++) {
      for (let idx = 0; idx < nBinsInRange; idx++) {
        const lo = Math.max(0, idx - MEDIAN_RADIUS_FREQ);
        const hi = Math.min(nBinsInRange - 1, idx + MEDIAN_RADIUS_FREQ);
        const len = hi - lo + 1;
        for (let i = 0; i < len; i++) win[i] = magByBin[lo + i][f];
        percEnh[idx][f] = medianOf(win, len);
      }
      if (f % 200 === 199) {
        opts.onProgress?.(0.65 + 0.15 * (f / nFrames));
        if (opts.yieldFn) await opts.yieldFn();
      }
    }
  }

  // --- Pass 2c: ソフトマスクを合成して元の振幅に適用 ---
  // 特定ビンだけ突出していれば調性音 (harmonic側が相対的に大きい)、
  // 広帯域にわたって同程度なら打楽器音 (percussive側が相対的に大きい) とみなす
  const filtered: Float32Array[] = inRangeBins.map(() => new Float32Array(nFrames));
  for (let idx = 0; idx < nBinsInRange; idx++) {
    const orig = magByBin[idx];
    const h = harmEnh[idx];
    const p = percEnh[idx];
    const dst = filtered[idx];
    for (let f = 0; f < nFrames; f++) {
      const h2 = h[f] * h[f];
      const p2 = p[f] * p[f];
      const maskH = h2 + p2 > 1e-12 ? h2 / (h2 + p2) : 0.5;
      dst[f] = orig[f] * maskH;
    }
  }

  // --- Pass 3: 対数圧縮 + 2ピッチクラスへの按分でchroma/bassChromaを構築 ---
  const chroma: Float32Array[] = Array.from({ length: nFrames }, () => new Float32Array(12));
  const bassChroma: Float32Array[] = Array.from({ length: nFrames }, () => new Float32Array(12));
  for (let idx = 0; idx < inRangeBins.length; idx++) {
    const k = inRangeBins[idx];
    const pcA = binPcA[k];
    const wA = binWA[k];
    const pcB = binPcB[k];
    const wB = binWB[k];
    const isBass = binIsBass[k] === 1;
    const src = filtered[idx];
    for (let f = 0; f < nFrames; f++) {
      const v = Math.log1p(src[f]);
      chroma[f][pcA] += v * wA;
      chroma[f][pcB] += v * wB;
      if (isBass) {
        bassChroma[f][pcA] += v * wA;
        bassChroma[f][pcB] += v * wB;
      }
    }
    if (idx % 100 === 99) {
      opts.onProgress?.(0.75 + 0.1 * (idx / inRangeBins.length));
      if (opts.yieldFn) await opts.yieldFn();
    }
  }

  return {
    novelty,
    chroma,
    bassChroma,
    energy,
    hopSec,
    centerOffset: N / 2 / sampleRate,
  };
}

/** 固定長の小さな窓を挿入ソートして中央値を取る (メモリ確保なし) */
function medianOf(win: Float32Array, len: number): number {
  for (let i = 1; i < len; i++) {
    const v = win[i];
    let j = i - 1;
    while (j >= 0 && win[j] > v) {
      win[j + 1] = win[j];
      j--;
    }
    win[j + 1] = v;
  }
  return win[len >> 1];
}

/** noveltyの自己相関からBPMを推定する */
function estimateTempo(
  novelty: Float32Array,
  hopSec: number
): { bpm: number; periodFrames: number; acfProminence: number } {
  const n = novelty.length;
  // 平均を引く
  let mean = 0;
  for (let i = 0; i < n; i++) mean += novelty[i];
  mean /= Math.max(1, n);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = novelty[i] - mean;

  const minLag = Math.max(1, Math.floor(60 / MAX_BPM / hopSec));
  const maxLag = Math.min(n - 1, Math.ceil(60 / MIN_BPM / hopSec));

  let bestLag = minLag;
  let bestScore = -Infinity;
  let sum = 0;
  let count = 0;
  const scores = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acf = 0;
    for (let i = 0; i + lag < n; i++) acf += x[i] * x[i + lag];
    acf /= n - lag;
    // J-POPで多い 90〜150BPM をゆるく優遇 (対数正規風の重み)
    const bpm = 60 / (lag * hopSec);
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.6, 2));
    const score = acf * (0.5 + 0.5 * w);
    scores[lag] = score;
    sum += score;
    count++;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  const avg = sum / Math.max(1, count);
  const acfProminence = avg > 0 ? bestScore / avg : 1;

  // 放物線補間でラグを小数精度に
  let lag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = scores[bestLag - 1], y1 = scores[bestLag], y2 = scores[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) lag = bestLag + (0.5 * (y0 - y2)) / denom;
  }

  return { bpm: 60 / (lag * hopSec), periodFrames: lag, acfProminence };
}

/** 拍の位相を決めて拍列を作る (拍時刻はフレーム中心基準 = アタック位置) */
function findBeats(
  frames: Frames,
  periodFrames: number,
  duration: number
): { beats: number[]; phaseContrast: number } {
  const { novelty, hopSec, centerOffset } = frames;
  const n = novelty.length;
  const steps = Math.max(8, Math.round(periodFrames * 2));
  let bestPhase = 0;
  let bestScore = -Infinity;
  let total = 0;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * periodFrames;
    let score = 0;
    let cnt = 0;
    for (let t = phase; t < n - 1; t += periodFrames) {
      const i = Math.floor(t);
      const frac = t - i;
      score += novelty[i] * (1 - frac) + novelty[i + 1] * frac;
      cnt++;
    }
    score /= Math.max(1, cnt);
    total += score;
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  const avgScore = total / steps;
  const phaseContrast = avgScore > 0 ? bestScore / avgScore : 1;

  const beats: number[] = [];
  for (let t = bestPhase; t * hopSec + centerOffset < duration; t += periodFrames) {
    beats.push(t * hopSec + centerOffset);
  }
  return { beats, phaseContrast };
}

/** 小節頭 (4拍子想定) を、拍位置のnovelty+和声変化から推定する */
function findDownbeats(
  beats: number[],
  frames: Frames
): { downbeats: number[]; firstDownbeat: number } {
  if (beats.length < 8) {
    return { downbeats: beats.filter((_, i) => i % 4 === 0), firstDownbeat: beats[0] ?? 0 };
  }
  const frameAt = (sec: number) =>
    Math.max(
      0,
      Math.min(frames.novelty.length - 1, Math.round((sec - frames.centerOffset) / frames.hopSec))
    );

  // 拍間の平均chroma
  const beatChroma: Float32Array[] = [];
  for (let b = 0; b < beats.length - 1; b++) {
    const f0 = frameAt(beats[b]);
    const f1 = Math.max(f0 + 1, frameAt(beats[b + 1]));
    const acc = new Float32Array(12);
    for (let f = f0; f < f1; f++) {
      const ch = frames.chroma[f];
      for (let p = 0; p < 12; p++) acc[p] += ch[p];
    }
    beatChroma.push(acc);
  }

  // noveltyと和声変化は単位が違うので、拍上のnovelty平均で正規化してから合成する
  let noveltyMean = 0;
  for (const b of beats) noveltyMean += frames.novelty[frameAt(b)];
  noveltyMean /= Math.max(1, beats.length);

  let bestOffset = 0;
  let bestScore = -Infinity;
  for (let o = 0; o < 4; o++) {
    let score = 0;
    let cnt = 0;
    for (let b = o; b < beats.length; b += 4) {
      score += noveltyMean > 0 ? frames.novelty[frameAt(beats[b])] / noveltyMean : 0;
      // 小節頭での和声変化 (前の拍とのchroma距離) を強めに加点
      if (b > 0 && b - 1 < beatChroma.length && b < beatChroma.length) {
        score += chromaDistance(beatChroma[b - 1], beatChroma[b]) * 2.0;
      }
      cnt++;
    }
    score /= Math.max(1, cnt);
    if (score > bestScore) {
      bestScore = score;
      bestOffset = o;
    }
  }

  const downbeats = beats.filter((_, i) => i >= bestOffset && (i - bestOffset) % 4 === 0);

  // 曲頭が欠けないよう、小節頭を先頭方向へ外挿する
  if (downbeats.length >= 2) {
    const barDur = downbeats[1] - downbeats[0];
    let t = downbeats[0] - barDur;
    while (t > -0.2 * barDur) {
      downbeats.unshift(Math.max(0, t));
      t -= barDur;
    }
  }
  return { downbeats, firstDownbeat: downbeats[0] ?? beats[0] };
}

function chromaDistance(a: Float32Array, b: Float32Array): number {
  const na = norm(a), nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  let dot = 0;
  for (let i = 0; i < 12; i++) dot += a[i] * b[i];
  return 1 - dot / (na * nb);
}

function norm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

/** コードテンプレート: ルートからの半音インターバルと、音ごとの重み (ルートを最も重視) */
interface ChordTemplate {
  quality: string;
  intervals: number[];
  weights: number[];
}

const CHORD_TEMPLATES: ChordTemplate[] = [
  { quality: "", intervals: [0, 4, 7], weights: [1.0, 0.85, 0.75] },
  { quality: "m", intervals: [0, 3, 7], weights: [1.0, 0.85, 0.75] },
  { quality: "7", intervals: [0, 4, 7, 10], weights: [1.0, 0.85, 0.75, 0.55] },
  { quality: "m7", intervals: [0, 3, 7, 10], weights: [1.0, 0.85, 0.75, 0.55] },
  { quality: "maj7", intervals: [0, 4, 7, 11], weights: [1.0, 0.85, 0.75, 0.5] },
  { quality: "6", intervals: [0, 4, 7, 9], weights: [1.0, 0.85, 0.75, 0.5] },
  { quality: "m6", intervals: [0, 3, 7, 9], weights: [1.0, 0.85, 0.75, 0.5] },
  { quality: "sus4", intervals: [0, 5, 7], weights: [1.0, 0.8, 0.75] },
  { quality: "sus2", intervals: [0, 2, 7], weights: [1.0, 0.8, 0.75] },
  { quality: "dim", intervals: [0, 3, 6], weights: [1.0, 0.8, 0.7] },
  { quality: "aug", intervals: [0, 4, 8], weights: [1.0, 0.8, 0.7] },
];

interface ChordMatch {
  name: string;
  rootPc: number;
  quality: string;
  tonePcs: number[];
  confidence: number;
  /** テンプレート照合の生スコア (小節分割の判断に使う。0以下は非マッチ) */
  score: number;
}

// ---- キー推定と調性バイアス ----

/** Krumhansl-Kessler のキープロファイル (メジャー / マイナー) */
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** コード種別を大まかなクラスに分類する (調性判定用) */
function qualityClass(quality: string): "maj" | "min" | "dim" | "aug" | "sus" {
  if (quality === "m" || quality === "m7" || quality === "m6") return "min";
  if (quality === "dim") return "dim";
  if (quality === "aug") return "aug";
  if (quality === "sus2" || quality === "sus4") return "sus";
  return "maj"; // "", "7", "maj7", "6"
}

export interface KeyEstimate {
  tonicPc: number;
  mode: "major" | "minor";
  confidence: number;
  /** キーに対するコードの事前確率的な重み (-penalty..+bonus)。調性バイアスに使う */
  bias: (rootPc: number, quality: string) => number;
}

/** ダイアトニック各度の期待コードクラス (トニックからの半音) */
const MAJOR_DEGREE_CLASS: Record<number, "maj" | "min" | "dim"> = {
  0: "maj", 2: "min", 4: "min", 5: "maj", 7: "maj", 9: "min", 11: "dim",
};
const MINOR_DEGREE_CLASS: Record<number, "maj" | "min" | "dim"> = {
  0: "min", 2: "dim", 3: "maj", 5: "min", 7: "min", 8: "maj", 10: "maj", 11: "dim",
};

/** キーに対するコードの調性バイアスを作る。
 *  ダイアトニックかつクラス一致で加点、スケール外で減点。
 *  ハード除外はしない (強い証拠があれば借用和音・転調も採用できるようにする)。 */
function makeKeyBias(tonicPc: number, mode: "major" | "minor"): (rootPc: number, quality: string) => number {
  const degClass = mode === "major" ? MAJOR_DEGREE_CLASS : MINOR_DEGREE_CLASS;
  // ダイアトニックで特に頻出のトニック/サブドミナント/ドミナントを厚めに
  const strongDeg = mode === "major" ? new Set([0, 5, 7]) : new Set([0, 5, 7, 8]);
  return (rootPc: number, quality: string) => {
    const deg = ((rootPc - tonicPc) % 12 + 12) % 12;
    const expected = degClass[deg];
    const cls = qualityClass(quality);
    if (cls === "sus") {
      // sus は調性中立寄り。ルートがダイアトニックなら軽く許容
      return expected !== undefined ? 0.01 : -0.03;
    }
    if (expected === undefined) {
      // スケール外のルート → 明確に減点 (「変なコード」の抑制)
      return -0.09;
    }
    if (cls === expected || (expected === "maj" && cls === "maj") || (expected === "min" && cls === "min")) {
      return strongDeg.has(deg) ? 0.09 : 0.06;
    }
    // ルートはダイアトニックだがクラス不一致 (例: 期待minにmaj) → わずかに許容
    return 0.0;
  };
}

/** 全体のchromaからキーを推定する */
function estimateKey(frames: Frames): KeyEstimate {
  // エネルギー重み付きの全体chroma
  const agg = new Float32Array(12);
  for (let f = 0; f < frames.chroma.length; f++) {
    const ch = frames.chroma[f];
    for (let p = 0; p < 12; p++) agg[p] += ch[p];
  }
  const mean = agg.reduce((s, v) => s + v, 0) / 12;
  const centered = agg.map((v) => v - mean);

  const corr = (profile: number[], rot: number) => {
    let pMean = 0;
    for (let i = 0; i < 12; i++) pMean += profile[i];
    pMean /= 12;
    let num = 0, dp = 0, dc = 0;
    for (let i = 0; i < 12; i++) {
      const pv = profile[(i - rot + 12) % 12] - pMean;
      num += pv * centered[i];
      dp += pv * pv;
      dc += centered[i] * centered[i];
    }
    return dp > 0 && dc > 0 ? num / Math.sqrt(dp * dc) : 0;
  };

  let best = { tonicPc: 0, mode: "major" as "major" | "minor", score: -Infinity };
  let second = -Infinity;
  for (let t = 0; t < 12; t++) {
    for (const mode of ["major", "minor"] as const) {
      const score = corr(mode === "major" ? KK_MAJOR : KK_MINOR, t);
      if (score > best.score) {
        second = best.score;
        best = { tonicPc: t, mode, score };
      } else if (score > second) {
        second = score;
      }
    }
  }
  const confidence = clamp01((best.score - second) * 2 + best.score * 0.3);
  return {
    tonicPc: best.tonicPc,
    mode: best.mode,
    confidence,
    bias: makeKeyBias(best.tonicPc, best.mode),
  };
}

/**
 * 全12ルート×全テンプレートを照合し、最良のコードを返す。
 * テンプレートごとに音数が違う (3和音 vs 4和音) ため、合計ではなく平均で
 * スコアリングし、音数が多いテンプレートが不当に有利にならないようにする。
 * keyBias が与えられた場合は、調性に沿ったコードを優遇 (スケール外を減点) する。
 */
function matchChord(
  chroma: Float32Array,
  keyBias?: (rootPc: number, quality: string) => number
): ChordMatch | null {
  const n = norm(chroma);
  if (n === 0) return null;
  const c = new Float32Array(12);
  for (let i = 0; i < 12; i++) c[i] = chroma[i] / n;

  let best = { score: -Infinity, rootPc: 0, template: CHORD_TEMPLATES[0] };
  let second = -Infinity;
  for (let root = 0; root < 12; root++) {
    for (const tpl of CHORD_TEMPLATES) {
      const tones = tpl.intervals.map((iv) => (root + iv) % 12);
      let pos = 0;
      for (let i = 0; i < tones.length; i++) pos += c[tones[i]] * tpl.weights[i];
      pos /= tones.length;
      let neg = 0;
      let negCount = 0;
      for (let p = 0; p < 12; p++) {
        if (!tones.includes(p)) {
          neg += c[p];
          negCount++;
        }
      }
      neg = negCount > 0 ? neg / negCount : 0;
      const score = pos - neg * 0.45 + (keyBias ? keyBias(root, tpl.quality) : 0);
      if (score > best.score) {
        second = best.score;
        best = { score, rootPc: root, template: tpl };
      } else if (score > second) {
        second = score;
      }
    }
  }
  if (best.score <= 0) return null;

  const tonePcs = best.template.intervals.map((iv) => (best.rootPc + iv) % 12);
  const margin = second > -Infinity ? (best.score - second) / Math.max(best.score, 1e-6) : 1;
  const confidence = clamp01(best.score * 1.3 + margin * 0.6);

  return {
    name: PC_NAMES[best.rootPc] + best.template.quality,
    rootPc: best.rootPc,
    quality: best.template.quality,
    tonePcs,
    confidence,
    score: best.score,
  };
}

interface BarSeg {
  start: number;
  end: number;
  match: ChordMatch | null;
  chroma: Float32Array;
  bassChroma: Float32Array;
}

/** 半小節に分割してよいと判断する条件。基本は1小節1コードとし、
 *  前半/後半のchromaが実際に大きく異なり (SPLIT_MIN_DIST)、かつ分割した方が
 *  1小節扱いより十分に当てはまりが良い (SPLIT_SCORE_MARGIN) 場合だけ2分割する。
 *  拍単位では絶対に分割しない (最小単位は半小節=2拍)。 */
const SPLIT_MIN_SCORE = 0.05;
const SPLIT_SCORE_MARGIN = 0.04;
const SPLIT_MIN_DIST = 0.18;

/** フレーム区間 [f0,f1) を中央値で集約する。合計ではなく中央値にすることで、
 *  突発的なノイズフレームが1〜2個混入しても結果が歪まない。 */
function aggregateFrames(
  frames: Frames,
  f0: number,
  f1: number,
  tmp: { buf: Float32Array }
): { chroma: Float32Array; bass: Float32Array; energy: number } {
  const len = Math.max(1, f1 - f0);
  if (len > tmp.buf.length) tmp.buf = new Float32Array(len);
  const buf = tmp.buf;
  const chroma = new Float32Array(12);
  const bass = new Float32Array(12);
  for (let p = 0; p < 12; p++) {
    for (let f = f0; f < f1; f++) buf[f - f0] = frames.chroma[f][p];
    chroma[p] = medianOf(buf, len);
    for (let f = f0; f < f1; f++) buf[f - f0] = frames.bassChroma[f][p];
    bass[p] = medianOf(buf, len);
  }
  let energy = 0;
  for (let f = f0; f < f1; f++) energy += frames.energy[f];
  energy /= len;
  return { chroma, bass, energy };
}

/** 2つのchromaベクトルのコサイン距離 (0=同じ, 1=直交) */
function cosineDistance(a: Float32Array, b: Float32Array): number {
  const na = norm(a), nb = norm(b);
  if (na === 0 || nb === 0) return 1;
  let dot = 0;
  for (let i = 0; i < 12; i++) dot += a[i] * b[i];
  return 1 - dot / (na * nb);
}

/**
 * 小節を基本単位としてコードを推定する。多くのJ-POPは1小節1コードで進行するため、
 * デフォルトは小節全体のchromaを1つのコードとして扱う。前半/後半のchromaが実際に
 * 大きく異なる場合 (2拍ずつ2コード) に限り、その小節だけ半小節に分割する。
 * 拍単位には決して分割しない (最小単位は半小節=2拍)。
 *
 * さらに、推定キーに沿った調性バイアスで「変なコード」を抑え、隣接小節との
 * 平滑化で孤立した外れコードを周囲に合わせる。
 */
function detectChordsPerBar(
  grid: BeatGrid,
  frames: Frames,
  duration: number,
  keyBias?: (rootPc: number, quality: string) => number
): AudioChordCandidate[] {
  const bars = grid.downbeats;
  if (bars.length < 1) return [];
  const frameAt = (sec: number) =>
    Math.max(
      0,
      Math.min(frames.chroma.length - 1, Math.round((sec - frames.centerOffset) / frames.hopSec))
    );

  // 全体の平均エネルギー (無音区間の除外用)
  let totalEnergy = 0;
  for (let f = 0; f < frames.energy.length; f++) totalEnergy += frames.energy[f];
  const avgEnergy = totalEnergy / Math.max(1, frames.energy.length);
  const silent = (energy: number) => energy < avgEnergy * 0.05;

  const tmp = { buf: new Float32Array(256) };
  const segs: BarSeg[] = [];

  for (let b = 0; b < bars.length; b++) {
    const start = bars[b];
    const end = b + 1 < bars.length ? bars[b + 1] : Math.min(duration, start + (60 / grid.bpm) * 4);
    if (end - start < 0.15) continue;

    const bf0 = frameAt(start);
    const bf1 = Math.max(bf0 + 1, frameAt(end));
    const whole = aggregateFrames(frames, bf0, bf1, tmp);
    if (silent(whole.energy)) continue;
    const wholeMatch = matchChord(whole.chroma, keyBias);

    const midF = Math.max(bf0 + 1, Math.min(bf1 - 1, frameAt(start + (end - start) / 2)));
    const first = aggregateFrames(frames, bf0, midF, tmp);
    const second = aggregateFrames(frames, midF, bf1, tmp);
    const firstMatch = silent(first.energy) ? null : matchChord(first.chroma, keyBias);
    const secondMatch = silent(second.energy) ? null : matchChord(second.chroma, keyBias);

    // 前半/後半が「別のコード」かつ chroma 自体が実際に大きく異なり、
    // 分割した方が1小節扱いより十分に当てはまりが良い場合だけ2分割する
    const halfDist = cosineDistance(first.chroma, second.chroma);
    const splitScore = firstMatch && secondMatch ? (firstMatch.score + secondMatch.score) / 2 : -Infinity;
    const shouldSplit =
      firstMatch !== null &&
      secondMatch !== null &&
      firstMatch.name !== secondMatch.name &&
      firstMatch.score > SPLIT_MIN_SCORE &&
      secondMatch.score > SPLIT_MIN_SCORE &&
      halfDist > SPLIT_MIN_DIST &&
      splitScore > (wholeMatch?.score ?? -Infinity) + SPLIT_SCORE_MARGIN;

    const mid = round3(start + (end - start) / 2);
    if (shouldSplit && firstMatch && secondMatch) {
      segs.push({ start: round3(start), end: mid, match: firstMatch, chroma: first.chroma, bassChroma: first.bass });
      segs.push({ start: mid, end: round3(end), match: secondMatch, chroma: second.chroma, bassChroma: second.bass });
    } else if (wholeMatch) {
      segs.push({ start: round3(start), end: round3(end), match: wholeMatch, chroma: whole.chroma, bassChroma: whole.bass });
    }
  }
  if (segs.length === 0) return [];

  // 平滑化: 前後の区間が同じコードで自分だけ違う孤立した外れ小節を周囲に合わせる。
  // ただし自分のコードが周囲より明確に強い (score差が大きい) 場合は残す。
  for (let i = 1; i < segs.length - 1; i++) {
    const prev = segs[i - 1].match, cur = segs[i].match, next = segs[i + 1].match;
    if (!prev || !cur || !next) continue;
    if (prev.name === next.name && cur.name !== prev.name) {
      // 周囲のコードを自分のchromaで採点し直し、大差なければ周囲に合わせる
      const neighborScore = scoreChordOn(segs[i].chroma, prev, keyBias);
      if (cur.score - neighborScore < 0.06) {
        segs[i] = { ...segs[i], match: { ...prev, confidence: prev.confidence * 0.9 } };
      }
    }
  }

  // 連続する同一コードの区間をまとめてセグメント化 (ベース音は区間全体で集計)
  const result: AudioChordCandidate[] = [];
  let i = 0;
  while (i < segs.length) {
    const cur = segs[i];
    if (!cur.match) {
      i++;
      continue;
    }
    let j = i + 1;
    const bassAcc = Float32Array.from(cur.bassChroma);
    while (j < segs.length && segs[j].match?.name === cur.match.name) {
      for (let p = 0; p < 12; p++) bassAcc[p] += segs[j].bassChroma[p];
      j++;
    }

    let name = cur.match.name;
    let bass = PC_NAMES[cur.match.rootPc];
    const bassPc = argmax(bassAcc);
    if (
      bassPc >= 0 &&
      bassPc !== cur.match.rootPc &&
      cur.match.tonePcs.includes(bassPc) &&
      bassAcc[bassPc] > bassAcc[cur.match.rootPc] * 1.4
    ) {
      bass = PC_NAMES[bassPc];
      name = `${cur.match.name}/${bass}`;
    }

    result.push({
      start: cur.start,
      end: segs[j - 1].end,
      chord: name,
      root: PC_NAMES[cur.match.rootPc],
      quality: cur.match.quality,
      bass,
      confidence: round3(cur.match.confidence),
    });
    i = j;
  }
  return result;
}

/** 既知コード match を chroma に対して採点する (平滑化での近傍比較用) */
function scoreChordOn(
  chroma: Float32Array,
  match: ChordMatch,
  keyBias?: (rootPc: number, quality: string) => number
): number {
  const n = norm(chroma);
  if (n === 0) return -Infinity;
  const c = new Float32Array(12);
  for (let i = 0; i < 12; i++) c[i] = chroma[i] / n;
  const tones = match.tonePcs;
  const tpl = CHORD_TEMPLATES.find((t) => t.quality === match.quality) ?? CHORD_TEMPLATES[0];
  let pos = 0;
  for (let i = 0; i < tones.length; i++) pos += c[tones[i]] * (tpl.weights[i] ?? 0.7);
  pos /= tones.length;
  let neg = 0, negCount = 0;
  for (let p = 0; p < 12; p++) {
    if (!tones.includes(p)) { neg += c[p]; negCount++; }
  }
  neg = negCount > 0 ? neg / negCount : 0;
  return pos - neg * 0.45 + (keyBias ? keyBias(match.rootPc, match.quality) : 0);
}

function argmax(v: Float32Array): number {
  let idx = -1;
  let max = -Infinity;
  for (let i = 0; i < v.length; i++) {
    if (v[i] > max) {
      max = v[i];
      idx = i;
    }
  }
  return max > 0 ? idx : -1;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

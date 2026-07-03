// 音源解析: BPM・拍位置・小節頭・chroma・コード候補・ベース音候補を推定する
//
// 完璧な自動採譜は目的ではない。少なくともBPMと拍・小節グリッドを取り、
// コード候補は「ユーザーがすぐ直せる叩き台」の品質を目指す。
// 純粋なTS実装 (Web Audio非依存) なので、Nodeでのテストとブラウザ実行を共用できる。

import { FFT, hannWindow } from "./fft";
import type { AudioAnalysisResult, AudioChordCandidate, BeatGrid } from "../types";

const FRAME_SIZE = 2048;
const HOP_SIZE = 512;
const MIN_BPM = 60;
const MAX_BPM = 200;

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
  opts.onProgress?.(0.7);

  const { bpm, periodFrames, acfProminence } = estimateTempo(frames.novelty, frames.hopSec);
  const { beats, phaseContrast } = findBeats(frames, periodFrames, duration);
  const { downbeats, firstDownbeat } = findDownbeats(beats, frames);
  opts.onProgress?.(0.85);

  const gridConfidence = clamp01(((phaseContrast - 1) * 1.6 + (acfProminence - 1.1) * 0.8) / 2);
  const grid: BeatGrid = {
    bpm: Math.round(bpm * 10) / 10,
    beats: beats.map(round3),
    downbeats: downbeats.map(round3),
    firstDownbeat: round3(firstDownbeat),
    confidence: round3(gridConfidence),
    source: "audio",
  };

  const chords = detectChords(grid, frames, duration);
  opts.onProgress?.(1);

  return { grid, chords, duration };
}

/** STFTでフレームごとの novelty / chroma / bass chroma / energy を計算 */
async function computeFrames(
  samples: Float32Array,
  sampleRate: number,
  opts: AnalyzeOptions
): Promise<Frames> {
  const fft = new FFT(FRAME_SIZE);
  const window = hannWindow(FRAME_SIZE);
  const nFrames = Math.max(0, Math.floor((samples.length - FRAME_SIZE) / HOP_SIZE) + 1);
  const hopSec = HOP_SIZE / sampleRate;

  const novelty = new Float32Array(nFrames);
  const energy = new Float32Array(nFrames);
  const chroma: Float32Array[] = [];
  const bassChroma: Float32Array[] = [];

  const buf = new Float32Array(FRAME_SIZE);
  const re = new Float32Array(FRAME_SIZE);
  const im = new Float32Array(FRAME_SIZE);
  const power = new Float32Array(FRAME_SIZE / 2);
  let prevMag = new Float32Array(FRAME_SIZE / 2);
  const curMag = new Float32Array(FRAME_SIZE / 2);

  // 周波数ビン -> ピッチクラス対応表 (55Hz〜4kHzをchroma、55〜260Hzをbassに)
  const binPc = new Int8Array(FRAME_SIZE / 2).fill(-1);
  const binIsBass = new Uint8Array(FRAME_SIZE / 2);
  for (let k = 1; k < FRAME_SIZE / 2; k++) {
    const freq = (k * sampleRate) / FRAME_SIZE;
    if (freq < 55 || freq > 4000) continue;
    const midi = 69 + 12 * Math.log2(freq / 440);
    binPc[k] = ((Math.round(midi) % 12) + 12) % 12;
    if (freq <= 260) binIsBass[k] = 1;
  }

  for (let f = 0; f < nFrames; f++) {
    const offset = f * HOP_SIZE;
    for (let i = 0; i < FRAME_SIZE; i++) buf[i] = samples[offset + i] * window[i];
    fft.powerSpectrum(buf, re, im, power);

    let flux = 0;
    let en = 0;
    const ch = new Float32Array(12);
    const bch = new Float32Array(12);
    for (let k = 1; k < FRAME_SIZE / 2; k++) {
      const mag = Math.sqrt(power[k]);
      curMag[k] = mag;
      en += power[k];
      const d = mag - prevMag[k];
      if (d > 0) flux += d;
      const pc = binPc[k];
      if (pc >= 0) {
        ch[pc] += mag;
        if (binIsBass[k]) bch[pc] += mag;
      }
    }
    novelty[f] = flux;
    energy[f] = en;
    chroma.push(ch);
    bassChroma.push(bch);
    // swap
    prevMag.set(curMag);

    if (f % 250 === 249) {
      opts.onProgress?.(0.7 * (f / nFrames));
      if (opts.yieldFn) await opts.yieldFn();
    }
  }

  return {
    novelty,
    chroma,
    bassChroma,
    energy,
    hopSec,
    centerOffset: FRAME_SIZE / 2 / sampleRate,
  };
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

/** 小節ごとのchromaをメジャー/マイナートライアドのテンプレートと照合してコード候補を出す */
function detectChords(grid: BeatGrid, frames: Frames, duration: number): AudioChordCandidate[] {
  const bars = grid.downbeats;
  if (bars.length < 2) return [];
  const frameAt = (sec: number) =>
    Math.max(
      0,
      Math.min(frames.chroma.length - 1, Math.round((sec - frames.centerOffset) / frames.hopSec))
    );

  // 全体の平均エネルギー (無音区間の除外用)
  let totalEnergy = 0;
  for (let f = 0; f < frames.energy.length; f++) totalEnergy += frames.energy[f];
  const avgEnergy = totalEnergy / Math.max(1, frames.energy.length);

  const raw: AudioChordCandidate[] = [];
  for (let b = 0; b < bars.length; b++) {
    const start = bars[b];
    const end = b + 1 < bars.length ? bars[b + 1] : Math.min(duration, start + (60 / grid.bpm) * 4);
    const f0 = frameAt(start);
    const f1 = Math.max(f0 + 1, frameAt(end));

    const ch = new Float32Array(12);
    const bch = new Float32Array(12);
    let en = 0;
    for (let f = f0; f < f1; f++) {
      const c = frames.chroma[f];
      const bc = frames.bassChroma[f];
      for (let p = 0; p < 12; p++) {
        ch[p] += c[p];
        bch[p] += bc[p];
      }
      en += frames.energy[f];
    }
    en /= f1 - f0;
    // ほぼ無音の小節はコードを出さない
    if (en < avgEnergy * 0.05) continue;

    const match = matchTriad(ch);
    if (!match) continue;

    // ベース音候補: bass chromaが最強のPCがコードトーンならオンコード扱い
    let bass: string | undefined;
    let name = match.name;
    const bassPc = argmax(bch);
    if (
      bassPc >= 0 &&
      bassPc !== match.rootPc &&
      match.tonePcs.includes(bassPc) &&
      bch[bassPc] > bch[match.rootPc] * 1.4
    ) {
      bass = PC_NAMES[bassPc];
      name = `${match.name}/${bass}`;
    }

    raw.push({
      start: round3(start),
      end: round3(end),
      chord: name,
      root: PC_NAMES[match.rootPc],
      quality: match.quality,
      bass: bass ?? PC_NAMES[match.rootPc],
      confidence: round3(match.confidence),
    });
  }

  // 連続する同一コードをマージ
  const merged: AudioChordCandidate[] = [];
  for (const c of raw) {
    const last = merged[merged.length - 1];
    if (last && last.chord === c.chord && Math.abs(last.end - c.start) < 0.05) {
      last.end = c.end;
      last.confidence = Math.max(last.confidence, c.confidence);
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

/** メジャー/マイナートライアド24種のテンプレート照合 + 7th拡張チェック */
function matchTriad(
  chroma: Float32Array
): { name: string; rootPc: number; quality: string; tonePcs: number[]; confidence: number } | null {
  const n = norm(chroma);
  if (n === 0) return null;
  const c = new Float32Array(12);
  for (let i = 0; i < 12; i++) c[i] = chroma[i] / n;

  let best = { score: -Infinity, rootPc: 0, minor: false };
  let second = -Infinity;
  for (let root = 0; root < 12; root++) {
    for (const minor of [false, true]) {
      const third = (root + (minor ? 3 : 4)) % 12;
      const fifth = (root + 7) % 12;
      // ルート・3度・5度を重み付きで合計し、非コードトーンを減点
      let score = c[root] * 1.0 + c[third] * 0.9 + c[fifth] * 0.7;
      for (let p = 0; p < 12; p++) {
        if (p !== root && p !== third && p !== fifth) score -= c[p] * 0.15;
      }
      if (score > best.score) {
        second = best.score;
        best = { score, rootPc: root, minor };
      } else if (score > second) {
        second = score;
      }
    }
  }
  if (best.score <= 0) return null;

  const { rootPc, minor } = best;
  const third = (rootPc + (minor ? 3 : 4)) % 12;
  const fifth = (rootPc + 7) % 12;
  const tonePcs = [rootPc, third, fifth];

  // b7が十分鳴っていればセブンスを付ける
  let quality = minor ? "m" : "";
  const b7 = (rootPc + 10) % 12;
  const triadAvg = (c[rootPc] + c[third] + c[fifth]) / 3;
  if (c[b7] > triadAvg * 0.75) {
    quality = minor ? "m7" : "7";
    tonePcs.push(b7);
  }

  // 信頼度: 絶対スコアと2位との差分から
  const margin = second > -Infinity ? (best.score - second) / Math.max(best.score, 1e-6) : 1;
  const confidence = clamp01(best.score * 0.55 + margin * 1.2);

  return { name: PC_NAMES[rootPc] + quality, rootPc, quality, tonePcs, confidence };
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

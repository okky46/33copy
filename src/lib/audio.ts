// Web Audioによる簡易ピアノ音源とコード再生
// 将来的にサンプラー音源(例: サウンドフォント)へ差し替えられるよう、
// ChordPlayer のインターフェースだけに依存させる

import { midiToFreq } from "./chords";

interface Voice {
  oscs: OscillatorNode[];
  gain: GainNode;
  stopAt: number;
}

export class ChordPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices: Voice[] = [];
  private _volume = 0.6;

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this._volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  get volume(): number {
    return this._volume;
  }

  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.02);
    }
  }

  /** AudioContextの現在時刻 (コードのみモードのクロックに使う) */
  now(): number {
    return this.ensureCtx().currentTime;
  }

  /**
   * MIDIノート群を鳴らす。
   * duration秒後に自然減衰で止まる。velocityで強さを調整。
   */
  playNotes(midiNotes: number[], duration = 1.5, velocity = 1): void {
    const ctx = this.ensureCtx();
    if (!this.master || midiNotes.length === 0) return;
    const t0 = ctx.currentTime;
    const dur = Math.max(0.15, duration);

    for (const midi of midiNotes) {
      const freq = midiToFreq(midi);
      const gain = ctx.createGain();

      // ピアノ風: 基音 + 弱い倍音、素早いアタックと指数減衰
      const partials: { mult: number; level: number; type: OscillatorType }[] = [
        { mult: 1, level: 0.5, type: "triangle" },
        { mult: 2, level: 0.12, type: "sine" },
        { mult: 3, level: 0.05, type: "sine" },
      ];
      const oscs: OscillatorNode[] = [];
      for (const p of partials) {
        const osc = ctx.createOscillator();
        osc.type = p.type;
        osc.frequency.value = freq * p.mult;
        const partGain = ctx.createGain();
        partGain.gain.value = p.level;
        osc.connect(partGain);
        partGain.connect(gain);
        osc.start(t0);
        osc.stop(t0 + dur + 0.3);
        oscs.push(osc);
      }

      // 低音ほど少し音量を抑える/高音とバランス
      const noteLevel = velocity * (midi < 48 ? 0.9 : 0.7);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(noteLevel, t0 + 0.012);
      gain.gain.setTargetAtTime(noteLevel * 0.35, t0 + 0.02, 0.35);
      gain.gain.setTargetAtTime(0, t0 + dur - 0.1, 0.08);
      gain.connect(this.master);

      this.voices.push({ oscs, gain, stopAt: t0 + dur + 0.3 });
    }
    this.cleanup();
  }

  /** 鳴っている音をすべて素早くフェードアウトして止める (シーク/ループ/停止時) */
  stopAll(fadeSec = 0.05): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      try {
        v.gain.gain.cancelScheduledValues(t);
        v.gain.gain.setTargetAtTime(0, t, fadeSec / 3);
        for (const o of v.oscs) o.stop(t + fadeSec + 0.05);
      } catch {
        // 既に停止済み
      }
    }
    this.voices = [];
  }

  private cleanup(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.voices = this.voices.filter((v) => v.stopAt > t);
  }
}

/** アプリ全体で共有するシングルトン */
let sharedPlayer: ChordPlayer | null = null;
export function getChordPlayer(): ChordPlayer {
  if (!sharedPlayer) sharedPlayer = new ChordPlayer();
  return sharedPlayer;
}

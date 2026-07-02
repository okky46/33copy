"use client";

// 同期エンジン: 再生モードに応じて「現在時刻」を1つのクロックに統一し、
// コード表示・鍵盤表示・コード音トリガー・ループを同期させる。
//
// - original:   YouTube再生位置がクロック。コード音は鳴らさない
// - mix:        YouTube再生位置がクロック。コード切り替わりでコード音を鳴らす
// - chordsOnly: AudioContextベースの内部クロック。コード進行だけを再生
//
// シーク/ループ/停止時は必ず stopAll() で古い音を消してから再トリガーする。

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChordEvent, LoopRange, PlayMode } from "@/lib/types";
import { chordIndexAt } from "@/lib/timeline";
import { parseChord, voiceChord } from "@/lib/chords";
import { getChordPlayer } from "@/lib/audio";
import type { YTPlayerHandle } from "./useYouTubePlayer";

interface EngineParams {
  mode: PlayMode;
  timeline: ChordEvent[];
  loop: LoopRange;
  duration: number;
  yt: YTPlayerHandle;
  ytIsPlaying: boolean;
  chordVolume: number; // 0..1
  chordLength: number; // 0.1..1 (コード区間に対する発音長)
}

export function useSyncEngine(params: EngineParams) {
  const { mode, timeline, loop, duration, yt, ytIsPlaying, chordVolume, chordLength } = params;

  // UI用は10fps程度に間引いた時刻、正確な値はrefで持つ
  const [currentTime, setCurrentTime] = useState(0);
  const [chordIndex, setChordIndex] = useState(-1);
  const [chordsOnlyPlaying, setChordsOnlyPlaying] = useState(false);

  const timeRef = useRef(0);
  const lastTickTime = useRef(-1);
  const lastChordIdx = useRef(-1);
  const lastUiUpdate = useRef(0);

  // コードのみモードの内部クロック
  const clock = useRef({ playing: false, baseCtx: 0, offset: 0 });

  // rAFコールバックから最新値を読めるようにrefに写す
  const p = useRef(params);
  p.current = params;

  const isPlaying = mode === "chordsOnly" ? chordsOnlyPlaying : ytIsPlaying;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const player = getChordPlayer();
  player.volume = chordVolume;

  /** コード音を今すぐ鳴らす (区間の残り時間 × 長さ設定) */
  const triggerChord = useCallback((ev: ChordEvent, t: number) => {
    const pl = getChordPlayer();
    pl.stopAll(0.04);
    const parsed = parseChord(ev.name);
    const v = voiceChord(parsed);
    const remain = Math.max(0.2, ev.end - t);
    pl.playNotes([...v.left, ...v.right], remain * p.current.chordLength, 0.9);
  }, []);

  /** 現在のクロック時刻を読む */
  const readClock = useCallback((): number => {
    const cur = p.current;
    if (cur.mode === "chordsOnly") {
      const c = clock.current;
      if (!c.playing) return c.offset;
      return c.offset + (getChordPlayer().now() - c.baseCtx);
    }
    return cur.yt.getCurrentTime();
  }, []);

  /** シーク (全モード共通入口) */
  const seek = useCallback((t: number) => {
    const cur = p.current;
    const clamped = Math.max(0, Math.min(t, cur.duration || t));
    getChordPlayer().stopAll(0.03);
    lastChordIdx.current = -2; // 再トリガーさせる
    if (cur.mode === "chordsOnly") {
      const c = clock.current;
      c.offset = clamped;
      c.baseCtx = getChordPlayer().now();
    } else {
      cur.yt.seekTo(clamped);
    }
    timeRef.current = clamped;
    setCurrentTime(clamped);
    setChordIndex(chordIndexAt(cur.timeline, clamped));
  }, []);

  const play = useCallback(() => {
    const cur = p.current;
    if (cur.mode === "chordsOnly") {
      const c = clock.current;
      if (!c.playing) {
        c.baseCtx = getChordPlayer().now();
        c.playing = true;
        lastChordIdx.current = -2; // 再開時に現在コードを鳴らす
        setChordsOnlyPlaying(true);
      }
    } else {
      cur.yt.play();
    }
  }, []);

  const pause = useCallback(() => {
    const cur = p.current;
    getChordPlayer().stopAll(0.06);
    if (cur.mode === "chordsOnly") {
      const c = clock.current;
      if (c.playing) {
        c.offset += getChordPlayer().now() - c.baseCtx;
        c.playing = false;
        setChordsOnlyPlaying(false);
      }
    } else {
      cur.yt.pause();
    }
  }, []);

  const togglePlay = useCallback(() => {
    if (isPlayingRef.current) pause();
    else play();
  }, [play, pause]);

  // モード切り替え時: 音を止め、クロックを引き継ぐ
  const prevMode = useRef(mode);
  useEffect(() => {
    if (prevMode.current === mode) return;
    const t = timeRef.current;
    getChordPlayer().stopAll(0.05);
    if (prevMode.current !== "chordsOnly") yt.pause();
    if (mode === "chordsOnly") {
      clock.current = { playing: false, baseCtx: 0, offset: t };
      setChordsOnlyPlaying(false);
    } else {
      yt.seekTo(t);
    }
    lastChordIdx.current = -2;
    prevMode.current = mode;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // メインループ (rAF)
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const cur = p.current;
      let t = readClock();

      // ループ処理: 終端を越えたら開始位置へ (古い音は必ず止める)
      if (cur.loop.enabled && cur.loop.end > cur.loop.start + 0.2) {
        if (t >= cur.loop.end - 0.02 || (isPlayingRef.current && t < cur.loop.start - 1.5)) {
          getChordPlayer().stopAll(0.03);
          lastChordIdx.current = -2;
          if (cur.mode === "chordsOnly") {
            clock.current.offset = cur.loop.start;
            clock.current.baseCtx = getChordPlayer().now();
          } else {
            cur.yt.seekTo(cur.loop.start);
          }
          t = cur.loop.start;
        }
      }

      // コードのみモード: 曲末で停止
      if (cur.mode === "chordsOnly" && cur.duration > 0 && t >= cur.duration) {
        getChordPlayer().stopAll(0.1);
        clock.current = { playing: false, baseCtx: 0, offset: cur.duration };
        setChordsOnlyPlaying(false);
        t = cur.duration;
      }

      // シーク検知 (YouTube側UIでのシーク含む): 大きく飛んだら音を止めて再トリガー
      const dt = Math.abs(t - lastTickTime.current);
      if (lastTickTime.current >= 0 && dt > 0.6) {
        getChordPlayer().stopAll(0.03);
        lastChordIdx.current = -2;
      }
      lastTickTime.current = t;
      timeRef.current = t;

      // 現在コードの判定とコード音トリガー
      const idx = chordIndexAt(cur.timeline, t);
      if (idx !== lastChordIdx.current) {
        const shouldSound =
          isPlayingRef.current && (cur.mode === "mix" || cur.mode === "chordsOnly");
        if (shouldSound) {
          if (idx >= 0) triggerChord(cur.timeline[idx], t);
          else getChordPlayer().stopAll(0.05);
        }
        lastChordIdx.current = idx;
        setChordIndex(idx);
      }

      // UI更新は約12fpsに間引く
      const now = performance.now();
      if (now - lastUiUpdate.current > 80) {
        lastUiUpdate.current = now;
        setCurrentTime(t);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [readClock, triggerChord]);

  // 一時停止したら音を止める (YouTube側の停止ボタン対応)
  useEffect(() => {
    if (!isPlaying) getChordPlayer().stopAll(0.08);
  }, [isPlaying]);

  return {
    currentTime,
    timeRef,
    chordIndex,
    isPlaying,
    play,
    pause,
    togglePlay,
    seek,
    /** 選択コードを手動で試聴する */
    audition: (ev: ChordEvent, part: "both" | "left" | "right") => {
      const parsed = parseChord(ev.name);
      const v = voiceChord(parsed);
      const notes =
        part === "left" ? v.left : part === "right" ? v.right : [...v.left, ...v.right];
      const pl = getChordPlayer();
      pl.stopAll(0.03);
      pl.playNotes(notes, 1.6, 0.9);
    },
  };
}

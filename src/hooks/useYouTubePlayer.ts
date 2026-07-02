"use client";

// YouTube IFrame Player APIのラッパーフック

import { useEffect, useRef, useState } from "react";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export interface YTPlayerHandle {
  getCurrentTime(): number;
  getDuration(): number;
  seekTo(t: number): void;
  play(): void;
  pause(): void;
  setVolume(v: number): void; // 0..100
  getVolume(): number;
}

let apiPromise: Promise<void> | null = null;
function loadIframeApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.YT?.Player) return Promise.resolve();
  if (!apiPromise) {
    apiPromise = new Promise<void>((resolve) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve();
      };
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    });
  }
  return apiPromise;
}

export function useYouTubePlayer(videoId: string | null, containerId: string) {
  const playerRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (!videoId) return;
    let destroyed = false;
    setReady(false);
    setIsPlaying(false);

    loadIframeApi().then(() => {
      if (destroyed) return;
      const container = document.getElementById(containerId);
      if (!container) return;
      playerRef.current = new window.YT.Player(containerId, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: {
          playsinline: 1,
          rel: 0,
          // controls=1: ユーザーがYouTube側でシークしてもrAFで検知して同期する
          controls: 1,
        },
        events: {
          onReady: () => {
            if (destroyed) return;
            setReady(true);
            const d = playerRef.current?.getDuration?.() ?? 0;
            if (d > 0) setDuration(d);
          },
          onStateChange: (e: any) => {
            if (destroyed) return;
            const YT = window.YT;
            setIsPlaying(e.data === YT.PlayerState.PLAYING);
            const d = playerRef.current?.getDuration?.() ?? 0;
            if (d > 0) setDuration(d);
          },
        },
      });
    });

    return () => {
      destroyed = true;
      try {
        playerRef.current?.destroy?.();
      } catch {
        // already gone
      }
      playerRef.current = null;
    };
  }, [videoId, containerId]);

  const handle: YTPlayerHandle = {
    getCurrentTime: () => {
      try { return playerRef.current?.getCurrentTime?.() ?? 0; } catch { return 0; }
    },
    getDuration: () => {
      try { return playerRef.current?.getDuration?.() ?? 0; } catch { return 0; }
    },
    seekTo: (t: number) => {
      try { playerRef.current?.seekTo?.(t, true); } catch { /* noop */ }
    },
    play: () => {
      try { playerRef.current?.playVideo?.(); } catch { /* noop */ }
    },
    pause: () => {
      try { playerRef.current?.pauseVideo?.(); } catch { /* noop */ }
    },
    setVolume: (v: number) => {
      try { playerRef.current?.setVolume?.(v); } catch { /* noop */ }
    },
    getVolume: () => {
      try { return playerRef.current?.getVolume?.() ?? 100; } catch { return 100; }
    },
  };

  return { handle, ready, isPlaying, duration };
}

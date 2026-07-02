"use client";

// コードタイムライン: ブロック表示・クリックでシーク/選択・
// 境界ドラッグでタイミング調整・ループ区間表示・再生カーソル

import { useEffect, useRef, useState } from "react";
import type { ChordEvent, LoopRange } from "@/lib/types";
import { chordColor, parseChord } from "@/lib/chords";

interface Props {
  timeline: ChordEvent[];
  duration: number;
  currentTime: number;
  chordIndex: number;
  loop: LoopRange;
  selectedId: string | null;
  onSeek: (t: number) => void;
  onSelect: (id: string | null) => void;
  /** コードi-1とiの境界時刻を変更 (i=0はコード0のstart) */
  onMoveBoundary: (index: number, t: number) => void;
}

export default function Timeline({
  timeline, duration, currentTime, chordIndex, loop, selectedId,
  onSeek, onSelect, onMoveBoundary,
}: Props) {
  const [pxPerSec, setPxPerSec] = useState(14);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ index: number } | null>(null);

  const totalW = Math.max(100, duration * pxPerSec);

  // 再生中はカーソルが見えるように自動スクロール
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || dragging.current) return;
    const cursorX = currentTime * pxPerSec;
    if (cursorX < el.scrollLeft + 40 || cursorX > el.scrollLeft + el.clientWidth - 60) {
      el.scrollLeft = Math.max(0, cursorX - el.clientWidth * 0.3);
    }
  }, [currentTime, pxPerSec]);

  const timeAtClientX = (clientX: number): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft;
    return Math.max(0, Math.min(duration, x / pxPerSec));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    onMoveBoundary(dragging.current.index, timeAtClientX(e.clientX));
  };

  const endDrag = () => { dragging.current = null; };

  // 目盛り (10秒ごと)
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += 10) ticks.push(t);

  return (
    <div className="timeline-outer">
      <div className="timeline-toolbar">
        <span className="muted small">タイムライン（クリックでシーク / ブロック左端をドラッグでタイミング調整）</span>
        <span className="zoom-controls">
          <button className="btn small" onClick={() => setPxPerSec((z) => Math.max(4, z / 1.4))}>−</button>
          <button className="btn small" onClick={() => setPxPerSec((z) => Math.min(80, z * 1.4))}>＋</button>
        </span>
      </div>
      <div
        className="timeline-scroll"
        ref={scrollRef}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        <div
          className="timeline-track"
          style={{ width: totalW }}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest(".chord-block, .boundary-handle")) return;
            onSeek(timeAtClientX(e.clientX));
            onSelect(null);
          }}
        >
          {/* ループ区間 */}
          {loop.enabled && loop.end > loop.start && (
            <div
              className="loop-region"
              style={{ left: loop.start * pxPerSec, width: (loop.end - loop.start) * pxPerSec }}
            />
          )}
          {/* コードブロック */}
          {timeline.map((ev, i) => {
            const parsed = parseChord(ev.name);
            const isMinor = /^m(?!aj)/.test(ev.quality);
            const w = Math.max(2, (ev.end - ev.start) * pxPerSec);
            return (
              <div
                key={ev.id}
                className={
                  "chord-block" +
                  (i === chordIndex ? " current" : "") +
                  (ev.id === selectedId ? " selected" : "") +
                  (ev.edited ? " edited" : "")
                }
                style={{
                  left: ev.start * pxPerSec,
                  width: w,
                  background: chordColor(parsed.rootPc, isMinor),
                }}
                title={`${ev.name} (${ev.start.toFixed(1)}s - ${ev.end.toFixed(1)}s)`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(ev.id);
                  onSeek(ev.start + 0.01);
                }}
              >
                <span className="chord-block-label">{ev.name}</span>
                {ev.section && i > 0 && timeline[i - 1].section !== ev.section && (
                  <span className="section-label">{ev.section}</span>
                )}
                {i > 0 && (
                  <span
                    className="boundary-handle"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      (e.target as HTMLElement).setPointerCapture(e.pointerId);
                      dragging.current = { index: i };
                    }}
                    onPointerUp={endDrag}
                  />
                )}
              </div>
            );
          })}
          {/* 目盛り */}
          {ticks.map((t) => (
            <div key={t} className="tick" style={{ left: t * pxPerSec }}>
              <span>{formatTime(t)}</span>
            </div>
          ))}
          {/* 再生カーソル */}
          <div className="cursor" style={{ left: currentTime * pxPerSec }} />
        </div>
      </div>
    </div>
  );
}

export function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

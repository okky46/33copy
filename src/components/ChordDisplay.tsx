"use client";

// 現在のコード表示カード: コード名・ベース音・左手/右手・説明・出典バッジ

import { describeChord, midiToName, parseChord, voiceChord } from "@/lib/chords";
import type { ChordEvent } from "@/lib/types";

interface Props {
  chord: ChordEvent | null;
  nextChord: ChordEvent | null;
  onAudition: (part: "both" | "left" | "right") => void;
}

export function sourceBadge(ev: ChordEvent): { label: string; cls: string } {
  if (ev.edited || ev.source === "user") return { label: "手動確定", cls: "badge-user" };
  if (ev.source === "consensus")
    return { label: `${ev.sourceCount}ソース一致`, cls: "badge-consensus" };
  if (ev.source === "external") return { label: "外部コード譜", cls: "badge-external" };
  return { label: "仮置き", cls: "badge-fallback" };
}

export default function ChordDisplay({ chord, nextChord, onAudition }: Props) {
  if (!chord) {
    return (
      <div className="chord-card empty">
        <div className="chord-name-big">—</div>
        <p className="muted">この位置にコードがありません</p>
      </div>
    );
  }

  const parsed = parseChord(chord.name);
  const v = voiceChord(parsed);
  const badge = sourceBadge(chord);

  return (
    <div className="chord-card">
      <div className="chord-head">
        <div className="chord-name-big">{chord.name}</div>
        <div className="chord-meta">
          <span className={`badge ${badge.cls}`} title={`信頼度 ${(chord.confidence * 100) | 0}%`}>
            {badge.label}
          </span>
          {nextChord && (
            <span className="next-chord">
              次: <b>{nextChord.name}</b>
            </span>
          )}
        </div>
      </div>
      <div className="chord-bass">
        ベース音: <b>{parsed.bass}</b>
        {parsed.isSlash && <span className="oncode-tag">オンコード</span>}
      </div>
      <div className="hands">
        <div className="hand hand-left">
          <span className="hand-label">左手</span>
          <span className="hand-notes">{v.left.map((n) => midiToName(n)).join(" ")}</span>
        </div>
        <div className="hand hand-right">
          <span className="hand-label">右手</span>
          <span className="hand-notes">{v.right.map((n) => midiToName(n)).join(" ")}</span>
        </div>
      </div>
      <p className="chord-desc">{describeChord(parsed)}</p>
      {chord.section && <p className="muted small">セクション: {chord.section}</p>}
      <div className="audition-row">
        <button className="btn small" onClick={() => onAudition("both")}>♪ 両手で鳴らす</button>
        <button className="btn small" onClick={() => onAudition("left")}>左手のみ</button>
        <button className="btn small" onClick={() => onAudition("right")}>右手のみ</button>
      </div>
    </div>
  );
}

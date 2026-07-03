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
  if (ev.edited || ev.source === "manual") return { label: "手動確定", cls: "badge-user" };
  if (ev.source === "merged") {
    const n = ev.evidence?.externalSources?.length ?? 2;
    return { label: `${n}ソース一致`, cls: "badge-consensus" };
  }
  if (ev.source === "audio-analysis") return { label: "音源解析", cls: "badge-audio" };
  if (ev.source === "saved") return { label: "保存済み", cls: "badge-user" };
  return { label: "外部コード譜", cls: "badge-external" };
}

const CONFIDENCE_LABEL: Record<ChordEvent["confidence"], string> = {
  high: "信頼度: 高",
  medium: "信頼度: 中",
  low: "信頼度: 低",
  unknown: "信頼度: 不明",
};

export function confidenceBadge(ev: ChordEvent): { label: string; cls: string } {
  return {
    label: CONFIDENCE_LABEL[ev.confidence],
    cls: `badge-conf-${ev.confidence}`,
  };
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
  const conf = confidenceBadge(chord);

  return (
    <div className="chord-card">
      <div className="chord-head">
        <div className="chord-name-big">{chord.name}</div>
        <div className="chord-meta">
          <span className={`badge ${badge.cls}`}>{badge.label}</span>
          <span className={`badge ${conf.cls}`} title={chord.evidence?.notes?.join(" / ")}>
            {conf.label}
          </span>
          {chord.needsReview && (
            <span className="badge badge-review" title={chord.evidence?.notes?.join(" / ") || "音源解析と矛盾する可能性があります"}>
              ⚠ 要確認
            </span>
          )}
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

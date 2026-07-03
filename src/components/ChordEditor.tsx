"use client";

// 選択中コードの編集パネル
// コード名・ルート・種別・ベース・開始/終了時間・メモを編集できる

import { useEffect, useState } from "react";
import type { ChordEvent } from "@/lib/types";
import { parseChord } from "@/lib/chords";
import { confidenceBadge, sourceBadge } from "./ChordDisplay";

const ROOTS = ["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"];
const QUALITIES = ["", "m", "7", "maj7", "m7", "6", "m6", "sus4", "sus2", "add9", "dim", "aug", "m7b5", "9", "m9", "maj9", "7sus4", "dim7"];

interface Props {
  chord: ChordEvent;
  currentTime: number;
  onChange: (patch: Partial<ChordEvent>) => void;
  onDelete: () => void;
  onSetStartToNow: () => void;
  onSetEndToNow: () => void;
  onAudition: (part: "both" | "left" | "right") => void;
}

export default function ChordEditor({
  chord, currentTime, onChange, onDelete, onSetStartToNow, onSetEndToNow, onAudition,
}: Props) {
  const [nameInput, setNameInput] = useState(chord.name);
  useEffect(() => setNameInput(chord.name), [chord.id, chord.name]);

  const parsed = parseChord(nameInput);
  const nameValid = parsed.valid;
  const badge = sourceBadge(chord);
  const conf = confidenceBadge(chord);

  /** コード名確定: パースしてroot/quality/bassも更新 */
  const commitName = (raw: string) => {
    const p = parseChord(raw);
    if (!p.valid) return;
    onChange({ name: p.name, root: p.root, quality: p.quality, bass: p.bass });
  };

  /** ルート/種別/ベースのセレクトからコード名を組み立て */
  const rebuild = (root: string, quality: string, bass: string) => {
    const name = root + quality + (bass && bass !== root ? `/${bass}` : "");
    setNameInput(name);
    commitName(name);
  };

  return (
    <div className="editor-panel">
      <div className="editor-head">
        <h3>コード編集</h3>
        <span className={`badge ${badge.cls}`}>{badge.label}</span>
        <span className={`badge ${conf.cls}`}>{conf.label}</span>
        {chord.needsReview && <span className="badge badge-review">⚠ 要確認</span>}
        {chord.evidence?.notes && chord.evidence.notes.length > 0 && (
          <span className="muted small">{chord.evidence.notes.join(" / ")}</span>
        )}
        <button className="btn small danger" onClick={onDelete}>削除</button>
      </div>

      <div className="editor-grid">
        <label>
          コード名
          <input
            className={nameValid ? "" : "invalid"}
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={() => commitName(nameInput)}
            onKeyDown={(e) => { if (e.key === "Enter") commitName(nameInput); }}
            placeholder="例: G/B, Am7"
          />
        </label>
        <label>
          ルート
          <select value={ROOTS.includes(chord.root) ? chord.root : "C"}
            onChange={(e) => rebuild(e.target.value, chord.quality, chord.bass === chord.root ? e.target.value : chord.bass)}>
            {ROOTS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <label>
          種別
          <select value={QUALITIES.includes(chord.quality) ? chord.quality : ""}
            onChange={(e) => rebuild(chord.root, e.target.value, chord.bass)}>
            {QUALITIES.map((q) => <option key={q} value={q}>{q || "メジャー"}</option>)}
          </select>
        </label>
        <label>
          ベース音
          <select value={ROOTS.includes(chord.bass) ? chord.bass : chord.root}
            onChange={(e) => rebuild(chord.root, chord.quality, e.target.value)}>
            {ROOTS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <label>
          開始 (秒)
          <div className="time-edit">
            <input
              type="number" step={0.1} min={0} value={round1(chord.start)}
              onChange={(e) => onChange({ start: parseFloat(e.target.value) || 0 })}
            />
            <button className="btn small" title={`現在位置 ${currentTime.toFixed(1)}s に合わせる (S)`}
              onClick={onSetStartToNow}>↧現在</button>
          </div>
        </label>
        <label>
          終了 (秒)
          <div className="time-edit">
            <input
              type="number" step={0.1} min={0} value={round1(chord.end)}
              onChange={(e) => onChange({ end: parseFloat(e.target.value) || 0 })}
            />
            <button className="btn small" title={`現在位置 ${currentTime.toFixed(1)}s に合わせる (E)`}
              onClick={onSetEndToNow}>↧現在</button>
          </div>
        </label>
        <label className="span2">
          メモ
          <input
            value={chord.memo ?? ""}
            onChange={(e) => onChange({ memo: e.target.value })}
            placeholder="例: ここはアルペジオで"
          />
        </label>
      </div>

      <div className="audition-row">
        <button className="btn small" onClick={() => onAudition("both")}>♪ 試聴</button>
        <button className="btn small" onClick={() => onAudition("left")}>左手</button>
        <button className="btn small" onClick={() => onAudition("right")}>右手</button>
      </div>
    </div>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

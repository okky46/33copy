"use client";

// ピアノ鍵盤表示 (C2..C6)
// 左手=青、右手=緑、ベース音は強調表示。音名ラベル付き

import { midiToName } from "@/lib/chords";

const LOW = 36; // C2
const HIGH = 84; // C6
const WHITE_W = 26;
const WHITE_H = 110;
const BLACK_W = 16;
const BLACK_H = 68;

const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);

interface Props {
  leftNotes: number[];
  rightNotes: number[];
}

export default function PianoKeyboard({ leftNotes, rightNotes }: Props) {
  const leftSet = new Set(leftNotes);
  const rightSet = new Set(rightNotes);
  const bassNote = leftNotes.length > 0 ? Math.min(...leftNotes) : -1;

  // 白鍵のx座標を計算
  const whiteKeys: { midi: number; x: number }[] = [];
  let x = 0;
  for (let m = LOW; m <= HIGH; m++) {
    if (WHITE_PCS.has(m % 12)) {
      whiteKeys.push({ midi: m, x });
      x += WHITE_W;
    }
  }
  const totalW = x;

  // 黒鍵は直前の白鍵の右端に重ねる
  const blackKeys: { midi: number; x: number }[] = [];
  for (let m = LOW; m <= HIGH; m++) {
    if (!WHITE_PCS.has(m % 12)) {
      const prevWhite = whiteKeys.filter((w) => w.midi < m).pop();
      if (prevWhite) blackKeys.push({ midi: m, x: prevWhite.x + WHITE_W - BLACK_W / 2 });
    }
  }

  const fillFor = (midi: number, isBlack: boolean): string => {
    if (leftSet.has(midi)) return midi === bassNote ? "var(--hl-bass)" : "var(--hl-left)";
    if (rightSet.has(midi)) return "var(--hl-right)";
    return isBlack ? "var(--black-key)" : "var(--white-key)";
  };

  const labeled = [...leftNotes, ...rightNotes];

  return (
    <div className="piano-wrap">
      <svg
        viewBox={`0 0 ${totalW} ${WHITE_H + 18}`}
        style={{ width: "100%", display: "block" }}
        role="img"
        aria-label="ピアノ鍵盤"
      >
        {whiteKeys.map((k) => (
          <rect
            key={k.midi}
            x={k.x}
            y={0}
            width={WHITE_W}
            height={WHITE_H}
            fill={fillFor(k.midi, false)}
            stroke="var(--white-key-stroke)"
            strokeWidth={1}
            rx={2}
          />
        ))}
        {blackKeys.map((k) => (
          <rect
            key={k.midi}
            x={k.x}
            y={0}
            width={BLACK_W}
            height={BLACK_H}
            fill={fillFor(k.midi, true)}
            stroke="var(--black-key-stroke)"
            strokeWidth={1}
            rx={2}
          />
        ))}
        {/* Cの位置にオクターブ名 */}
        {whiteKeys
          .filter((k) => k.midi % 12 === 0)
          .map((k) => (
            <text key={`oct-${k.midi}`} x={k.x + 4} y={WHITE_H + 13} fontSize={9} fill="var(--muted)">
              {midiToName(k.midi)}
            </text>
          ))}
        {/* 押さえる音のラベル */}
        {labeled.map((m) => {
          const isBlack = !WHITE_PCS.has(m % 12);
          const key = isBlack
            ? blackKeys.find((k) => k.midi === m)
            : whiteKeys.find((k) => k.midi === m);
          if (!key) return null;
          const cx = key.x + (isBlack ? BLACK_W / 2 : WHITE_W / 2);
          const cy = isBlack ? BLACK_H - 12 : WHITE_H - 14;
          return (
            <g key={`lbl-${m}`}>
              <circle cx={cx} cy={cy} r={8} fill="var(--key-label-bg)" />
              <text
                x={cx}
                y={cy + 3}
                fontSize={8}
                fontWeight={700}
                textAnchor="middle"
                fill="var(--key-label-text)"
              >
                {midiToName(m).replace(/\d+$/, "")}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="piano-legend">
        <span><i className="dot dot-left" /> 左手 (ベース)</span>
        <span><i className="dot dot-right" /> 右手</span>
      </div>
    </div>
  );
}

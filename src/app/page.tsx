"use client";

// メイン画面: URL入力 → 解析 → YouTube同期コード表示・編集・保存

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalyzeResult, ChordEvent, Project, PlayMode } from "@/lib/types";
import { buildTimeline, normalizeTimeline, splitAt, addChordAt } from "@/lib/timeline";
import { parseChord, voiceChord } from "@/lib/chords";
import { deleteProject, listProjects, loadProject, saveProject } from "@/lib/storage";
import { useYouTubePlayer } from "@/hooks/useYouTubePlayer";
import { useSyncEngine } from "@/hooks/useSyncEngine";
import PianoKeyboard from "@/components/PianoKeyboard";
import ChordDisplay from "@/components/ChordDisplay";
import Timeline, { formatTime } from "@/components/Timeline";
import ChordEditor from "@/components/ChordEditor";

const ANALYZE_STEPS = [
  "動画情報を取得中…",
  "曲名・アーティスト名を推定中…",
  "外部コード譜を検索中…",
  "複数ソースのコードを照合中…",
  "コードタイムラインを生成中…",
];

const PLAYER_CONTAINER_ID = "yt-player-container";

export default function Home() {
  const [urlInput, setUrlInput] = useState("");
  const [analyzeStep, setAnalyzeStep] = useState(-1); // -1 = 解析中でない
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [project, setProject] = useState<Project | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [savedProjects, setSavedProjects] = useState<Project[]>([]);
  const [savedFlash, setSavedFlash] = useState(false);

  // 解析結果 (動画長が後から判明したときのタイムライン構築用)
  const pendingResult = useRef<AnalyzeResult | null>(null);

  const { handle: yt, isPlaying: ytIsPlaying, duration: ytDuration } = useYouTubePlayer(
    project?.videoId ?? null,
    PLAYER_CONTAINER_ID
  );

  const duration = project ? (project.duration || ytDuration) : 0;
  const mode = project?.settings.playMode ?? "original";
  const loop = project?.loop ?? { enabled: false, start: 0, end: 0 };
  const timeline = useMemo(() => project?.timeline ?? [], [project?.timeline]);

  const engine = useSyncEngine({
    mode,
    timeline,
    loop,
    duration,
    yt,
    ytIsPlaying,
    chordVolume: project?.settings.chordVolume ?? 0.6,
    chordLength: project?.settings.chordLength ?? 0.9,
  });

  const currentChord = engine.chordIndex >= 0 ? timeline[engine.chordIndex] : null;
  const nextChord = engine.chordIndex >= 0 ? timeline[engine.chordIndex + 1] ?? null : null;
  const selectedChord = timeline.find((e) => e.id === selectedId) ?? null;

  // 起動時に保存済みプロジェクト一覧
  useEffect(() => setSavedProjects(listProjects()), [project]);

  // プレイヤーから動画長が判明したら、タイムライン未構築なら構築する
  useEffect(() => {
    if (!project || ytDuration <= 0) return;
    if (project.timeline.length === 0 && pendingResult.current) {
      const tl = buildTimeline(pendingResult.current.progression, ytDuration);
      setProject((p) => (p ? { ...p, duration: ytDuration, timeline: tl } : p));
    } else if (!project.duration) {
      setProject((p) => (p ? { ...p, duration: ytDuration } : p));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytDuration, project?.videoId]);

  // 自動保存 (800msデバウンス)
  useEffect(() => {
    if (!project || project.timeline.length === 0) return;
    const timer = setTimeout(() => saveProject(project), 800);
    return () => clearTimeout(timer);
  }, [project]);

  /** 解析実行 */
  const analyze = useCallback(async (force = false) => {
    setError("");
    setNotice("");
    const url = urlInput.trim();
    if (!url) return;

    // 保存済みプロジェクトがあればそれを開く
    if (!force) {
      const idMatch = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})|^([A-Za-z0-9_-]{11})$/);
      const vid = idMatch ? (idMatch[1] || idMatch[2]) : null;
      if (vid) {
        const saved = loadProject(vid);
        if (saved) {
          pendingResult.current = null;
          setProject(saved);
          setSelectedId(null);
          setNotice("保存済みプロジェクトを読み込みました。最初から解析し直す場合は「再解析」を押してください。");
          return;
        }
      }
    }

    setAnalyzeStep(0);
    // 解析中のステップ表示を進める (演出。実際の解析は1リクエスト)
    const stepTimer = setInterval(() => {
      setAnalyzeStep((s) => (s >= 0 && s < ANALYZE_STEPS.length - 1 ? s + 1 : s));
    }, 2500);

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "解析に失敗しました");
        return;
      }
      const result = data as AnalyzeResult;
      pendingResult.current = result;
      const tl = result.duration > 0 ? buildTimeline(result.progression, result.duration) : [];
      const now = Date.now();
      setProject({
        videoId: result.videoId,
        videoTitle: result.videoTitle,
        channelName: result.channelName,
        duration: result.duration,
        songGuess: result.songGuess,
        sources: result.sources,
        timeline: tl,
        loop: { enabled: false, start: 0, end: 0 },
        settings: { playMode: "original", chordVolume: 0.6, chordLength: 0.9 },
        updatedAt: now,
        createdAt: now,
      });
      setSelectedId(null);
      setNotice(result.message);
    } catch {
      setError("解析リクエストに失敗しました。ネットワークを確認してください。");
    } finally {
      clearInterval(stepTimer);
      setAnalyzeStep(-1);
    }
  }, [urlInput]);

  /** タイムライン更新の共通入口 */
  const updateTimeline = useCallback((fn: (tl: ChordEvent[]) => ChordEvent[]) => {
    setProject((p) => (p ? { ...p, timeline: normalizeTimeline(fn(p.timeline)) } : p));
  }, []);

  /** コード編集 (ユーザー確定扱いにする) */
  const editChord = useCallback((id: string, patch: Partial<ChordEvent>) => {
    updateTimeline((tl) =>
      tl.map((e) =>
        e.id === id ? { ...e, ...patch, edited: true, source: "user", confidence: 1 } : e
      )
    );
  }, [updateTimeline]);

  /** タイムライン境界のドラッグ移動 */
  const moveBoundary = useCallback((index: number, t: number) => {
    updateTimeline((tl) => {
      if (index <= 0 || index >= tl.length) return tl;
      const prev = tl[index - 1];
      const cur = tl[index];
      const clamped = Math.max(prev.start + 0.1, Math.min(cur.end - 0.1, t));
      const updated = [...tl];
      updated[index - 1] = { ...prev, end: clamped, edited: true };
      updated[index] = { ...cur, start: clamped, edited: true };
      return updated;
    });
  }, [updateTimeline]);

  const setting = useCallback(<K extends keyof Project["settings"]>(key: K, value: Project["settings"][K]) => {
    setProject((p) => (p ? { ...p, settings: { ...p.settings, [key]: value } } : p));
  }, []);

  const setLoop = useCallback((patch: Partial<Project["loop"]>) => {
    setProject((p) => (p ? { ...p, loop: { ...p.loop, ...patch } } : p));
  }, []);

  /** 「ここで次のコード」 */
  const splitAtNow = useCallback(() => {
    const t = engine.timeRef.current;
    updateTimeline((tl) => splitAt(tl, t));
  }, [engine.timeRef, updateTimeline]);

  /** 現在位置にコードを追加 */
  const addAtNow = useCallback(() => {
    const t = engine.timeRef.current;
    updateTimeline((tl) => addChordAt(tl, t, "C"));
  }, [engine.timeRef, updateTimeline]);

  /** 選択コードの開始/終了を現在位置に */
  const setStartToNow = useCallback(() => {
    if (!selectedId) return;
    const t = engine.timeRef.current;
    updateTimeline((tl) => {
      const idx = tl.findIndex((e) => e.id === selectedId);
      if (idx < 0) return tl;
      const updated = [...tl];
      updated[idx] = { ...updated[idx], start: t, edited: true };
      if (idx > 0 && updated[idx - 1].end > t) {
        updated[idx - 1] = { ...updated[idx - 1], end: t, edited: true };
      }
      return updated;
    });
  }, [selectedId, engine.timeRef, updateTimeline]);

  const setEndToNow = useCallback(() => {
    if (!selectedId) return;
    const t = engine.timeRef.current;
    updateTimeline((tl) => {
      const idx = tl.findIndex((e) => e.id === selectedId);
      if (idx < 0) return tl;
      const updated = [...tl];
      updated[idx] = { ...updated[idx], end: t, edited: true };
      if (idx < tl.length - 1 && updated[idx + 1].start < t) {
        updated[idx + 1] = { ...updated[idx + 1], start: t, edited: true };
      }
      return updated;
    });
  }, [selectedId, engine.timeRef, updateTimeline]);

  // キーボードショートカット
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!project) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          engine.togglePlay();
          break;
        case "n": case "N": case "Enter":
          e.preventDefault();
          splitAtNow();
          break;
        case "a": case "A":
          e.preventDefault();
          addAtNow();
          break;
        case "[":
          setLoop({ start: engine.timeRef.current });
          break;
        case "]":
          setLoop({ end: engine.timeRef.current });
          break;
        case "l": case "L":
          setLoop({ enabled: !loop.enabled });
          break;
        case "s": case "S":
          setStartToNow();
          break;
        case "e": case "E":
          setEndToNow();
          break;
        case "ArrowLeft":
          e.preventDefault();
          engine.seek(engine.timeRef.current - 2);
          break;
        case "ArrowRight":
          e.preventDefault();
          engine.seek(engine.timeRef.current + 2);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [project, loop.enabled, engine, splitAtNow, addAtNow, setLoop, setStartToNow, setEndToNow]);

  // 表示用ボイシング (現在コード)
  const voicing = useMemo(() => {
    if (!currentChord) return { left: [], right: [] };
    return voiceChord(parseChord(currentChord.name));
  }, [currentChord]);

  const analyzing = analyzeStep >= 0;

  return (
    <main className="app">
      <header className="header">
        <h1 className="logo">🎹 OtoCopy</h1>
        <div className="url-row">
          <input
            className="url-input"
            placeholder="YouTubeのURLを貼ってください (例: https://www.youtube.com/watch?v=...)"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !analyzing) void analyze(); }}
            disabled={analyzing}
          />
          <button className="btn primary" onClick={() => void analyze()} disabled={analyzing || !urlInput.trim()}>
            {analyzing ? "解析中…" : "解析する"}
          </button>
          {project && (
            <button className="btn" onClick={() => void analyze(true)} disabled={analyzing} title="保存内容を無視して最初から解析し直す">
              再解析
            </button>
          )}
        </div>
      </header>

      {analyzing && (
        <div className="analyze-progress">
          <div className="spinner" />
          <ol>
            {ANALYZE_STEPS.map((s, i) => (
              <li key={s} className={i < analyzeStep ? "done" : i === analyzeStep ? "active" : ""}>
                {i < analyzeStep ? "✓ " : ""}{s}
              </li>
            ))}
          </ol>
        </div>
      )}

      {error && <div className="alert error">{error}</div>}
      {notice && !analyzing && (
        <div className="alert notice">
          {notice}
          <button className="alert-close" onClick={() => setNotice("")}>×</button>
        </div>
      )}

      {!project && !analyzing && (
        <section className="start-screen">
          <p className="lead">
            YouTubeのJ-POPリンクを貼ると、コード進行を自動推定して、<br />
            原曲と同期しながら「今鳴っているコード・ベース音・ピアノの押さえ方」を表示します。
          </p>
          {savedProjects.length > 0 && (
            <div className="project-list">
              <h2>保存済みプロジェクト</h2>
              <ul>
                {savedProjects.map((pr) => (
                  <li key={pr.videoId}>
                    <button
                      className="project-item"
                      onClick={() => {
                        pendingResult.current = null;
                        setProject(pr);
                        setUrlInput(`https://www.youtube.com/watch?v=${pr.videoId}`);
                        setSelectedId(null);
                      }}
                    >
                      <b>{pr.songGuess.title || pr.videoTitle}</b>
                      <span className="muted"> {pr.songGuess.artist}</span>
                      <span className="muted small"> — {pr.timeline.length}コード / {new Date(pr.updatedAt).toLocaleString("ja-JP")}</span>
                    </button>
                    <button
                      className="btn small danger"
                      onClick={() => { deleteProject(pr.videoId); setSavedProjects(listProjects()); }}
                    >
                      削除
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {project && (
        <>
          <section className="song-info">
            <div>
              <h2 className="song-title">
                {project.songGuess.title || project.videoTitle}
                {project.songGuess.artist && <span className="artist"> / {project.songGuess.artist}</span>}
              </h2>
              <p className="muted small">{project.videoTitle} — {project.channelName}</p>
            </div>
            <div className="song-actions">
              <button
                className="btn"
                onClick={() => { saveProject(project); setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1500); setSavedProjects(listProjects()); }}
              >
                {savedFlash ? "✓ 保存しました" : "保存"}
              </button>
              <button className="btn" onClick={() => { engine.pause(); setProject(null); setSelectedId(null); setNotice(""); }}>
                閉じる
              </button>
            </div>
          </section>

          {project.sources.length > 0 && (
            <details className="sources-detail">
              <summary>参照した外部コード譜 ({project.sources.length}件)</summary>
              <ul>
                {project.sources.map((s) => (
                  <li key={s.url}>
                    <a href={s.url} target="_blank" rel="noreferrer">{s.pageTitle || s.url}</a>
                    <span className="muted small"> ({s.provider}, {s.chordCount}コード)</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="main-grid">
            <div className="left-col">
              <div className="video-wrap">
                <div id={PLAYER_CONTAINER_ID} />
              </div>

              <div className="transport">
                <div className="mode-row">
                  <span className="label">再生モード</span>
                  {(
                    [
                      ["original", "原曲のみ"],
                      ["mix", "原曲＋コード"],
                      ["chordsOnly", "コードのみ"],
                    ] as [PlayMode, string][]
                  ).map(([m, label]) => (
                    <button
                      key={m}
                      className={`btn mode-btn ${mode === m ? "active" : ""}`}
                      onClick={() => setting("playMode", m)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="transport-row">
                  <button className="btn primary" onClick={engine.togglePlay}>
                    {engine.isPlaying ? "⏸ 停止" : "▶ 再生"}
                  </button>
                  <span className="time-display">
                    {formatTime(engine.currentTime)} / {formatTime(duration)}
                  </span>
                  <label className="slider-label">
                    コード音量
                    <input
                      type="range" min={0} max={1} step={0.05}
                      value={project.settings.chordVolume}
                      onChange={(e) => setting("chordVolume", parseFloat(e.target.value))}
                    />
                  </label>
                  <label className="slider-label">
                    コード音の長さ
                    <input
                      type="range" min={0.2} max={1} step={0.05}
                      value={project.settings.chordLength}
                      onChange={(e) => setting("chordLength", parseFloat(e.target.value))}
                    />
                  </label>
                </div>
                <div className="loop-row">
                  <span className="label">ループ</span>
                  <button
                    className={`btn small ${loop.enabled ? "active" : ""}`}
                    onClick={() => setLoop({ enabled: !loop.enabled })}
                    title="ショートカット: L"
                  >
                    {loop.enabled ? "ON" : "OFF"}
                  </button>
                  <button className="btn small" onClick={() => setLoop({ start: engine.timeRef.current })} title="ショートカット: [">
                    開始=現在
                  </button>
                  <button className="btn small" onClick={() => setLoop({ end: engine.timeRef.current })} title="ショートカット: ]">
                    終了=現在
                  </button>
                  <input
                    type="number" className="loop-input" step={0.1} min={0}
                    value={Math.round(loop.start * 10) / 10}
                    onChange={(e) => setLoop({ start: parseFloat(e.target.value) || 0 })}
                  />
                  <span>〜</span>
                  <input
                    type="number" className="loop-input" step={0.1} min={0}
                    value={Math.round(loop.end * 10) / 10}
                    onChange={(e) => setLoop({ end: parseFloat(e.target.value) || 0 })}
                  />
                  <span className="muted small">秒</span>
                </div>
              </div>
            </div>

            <div className="right-col">
              <ChordDisplay
                chord={currentChord}
                nextChord={nextChord}
                onAudition={(part) => currentChord && engine.audition(currentChord, part)}
              />
              <PianoKeyboard leftNotes={voicing.left} rightNotes={voicing.right} />
            </div>
          </div>

          <div className="timeline-actions">
            <button className="btn" onClick={addAtNow} title="ショートカット: A">＋ 現在位置にコード追加</button>
            <button className="btn" onClick={splitAtNow} title="ショートカット: N / Enter">✂ ここで次のコード</button>
            <span className="muted small shortcut-hint">
              Space: 再生/停止 ・ N: コード切替位置を打つ ・ [ ]: ループ区間 ・ S/E: 選択コードの開始/終了=現在 ・ ←→: 2秒移動
            </span>
          </div>

          <Timeline
            timeline={timeline}
            duration={duration}
            currentTime={engine.currentTime}
            chordIndex={engine.chordIndex}
            loop={loop}
            selectedId={selectedId}
            onSeek={engine.seek}
            onSelect={setSelectedId}
            onMoveBoundary={moveBoundary}
          />

          {selectedChord && (
            <ChordEditor
              chord={selectedChord}
              currentTime={engine.currentTime}
              onChange={(patch) => editChord(selectedChord.id, patch)}
              onDelete={() => {
                updateTimeline((tl) => tl.filter((e) => e.id !== selectedChord.id));
                setSelectedId(null);
              }}
              onSetStartToNow={setStartToNow}
              onSetEndToNow={setEndToNow}
              onAudition={(part) => engine.audition(selectedChord, part)}
            />
          )}
        </>
      )}

      <footer className="footer muted small">
        コード候補は外部コード譜・推定に基づく参考情報です。タイミングは目安なので、再生しながら調整してください。
      </footer>
    </main>
  );
}

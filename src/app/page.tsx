"use client";

// メイン画面: URL入力 → 解析 → YouTube同期コード表示・編集・保存
//
// プロダクト方針:
// - 根拠 (外部コード譜 / 音源解析 / 手動入力 / 保存済み) のないコード進行は表示しない
// - 取得できなかった場合は正直に伝え、音源解析・曲名修正・手動入力へ誘導する
// - タイミングは拍・小節グリッドに沿わせ、ユーザーがすぐ直せるようにする

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalyzeResult, ChordEvent, Project, PlayMode, SnapMode } from "@/lib/types";
import {
  addChordAt,
  normalizeTimeline,
  placeOnGrid,
  rebuildGrid,
  shiftTimeline,
  snapTime,
  splitAt,
} from "@/lib/timeline";
import { integrate, verifyWithAudio } from "@/lib/integrate";
import { parseChord, voiceChord } from "@/lib/chords";
import { deleteProject, listProjects, loadProject, saveProject } from "@/lib/storage";
import { decodeAudioFile } from "@/lib/audioAnalysis/decode";
import { analyzeAudio } from "@/lib/audioAnalysis/analyze";
import { useYouTubePlayer } from "@/hooks/useYouTubePlayer";
import { useSyncEngine } from "@/hooks/useSyncEngine";
import PianoKeyboard from "@/components/PianoKeyboard";
import ChordDisplay from "@/components/ChordDisplay";
import Timeline, { formatTime } from "@/components/Timeline";
import ChordEditor from "@/components/ChordEditor";
import ThemeToggle from "@/components/ThemeToggle";

const ANALYZE_STEPS = [
  "曲情報を取得中…",
  "曲名・アーティスト名を推定中…",
  "外部コード情報を検索中…",
  "コード候補を統合中…",
  "タイムラインを生成中…",
];

const PLAYER_CONTAINER_ID = "yt-player-container";

export default function Home() {
  const [urlInput, setUrlInput] = useState("");
  const [analyzeStep, setAnalyzeStep] = useState(-1); // -1 = 解析中でない
  const [audioProgress, setAudioProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [project, setProject] = useState<Project | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [savedProjects, setSavedProjects] = useState<Project[]>([]);
  const [savedFlash, setSavedFlash] = useState(false);
  const [searchTitle, setSearchTitle] = useState("");
  const [searchArtist, setSearchArtist] = useState("");

  // 解析結果 (動画長が後から判明したときの統合用)
  const pendingResult = useRef<AnalyzeResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { handle: yt, isPlaying: ytIsPlaying, duration: ytDuration } = useYouTubePlayer(
    project?.videoId ?? null,
    PLAYER_CONTAINER_ID
  );

  const duration = project ? (project.duration || ytDuration) : 0;
  const mode = project?.settings.playMode ?? "original";
  const snapMode = project?.settings.snapMode ?? "beat";
  const loop = project?.loop ?? { enabled: false, start: 0, end: 0 };
  const timeline = useMemo(() => project?.timeline ?? [], [project?.timeline]);
  const grid = project?.beatGrid ?? null;

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

  useEffect(() => setSavedProjects(listProjects()), [project]);

  // 曲名修正フォームの初期値
  useEffect(() => {
    if (project) {
      setSearchTitle(project.songGuess.title);
      setSearchArtist(project.songGuess.artist);
    }
  }, [project?.videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 解析結果 + (あれば) 音源解析を統合してプロジェクトに反映する */
  const applyIntegration = useCallback(
    (result: AnalyzeResult, dur: number, base?: Project | null) => {
      const audioGrid = base?.beatGrid?.source === "audio" ? base.beatGrid : null;
      const out = integrate({
        progression: result.progression,
        sourceCount: result.sources.length,
        duration: dur,
        audioGrid,
        audioChords: base?.audioChords ?? null,
      });
      const now = Date.now();
      setProject({
        videoId: result.videoId,
        videoTitle: result.videoTitle,
        channelName: result.channelName,
        duration: dur,
        songGuess: result.songGuess,
        sources: result.sources,
        progression: result.progression,
        timeline: out.timeline,
        beatGrid: out.grid ?? audioGrid,
        audioChords: base?.audioChords,
        audioFileName: base?.audioFileName,
        analysis: out.summary,
        debug: result.debug,
        loop: base?.loop ?? { enabled: false, start: 0, end: 0 },
        settings:
          base?.settings ?? { playMode: "original", chordVolume: 0.6, chordLength: 0.9, snapMode: "beat" },
        updatedAt: now,
        createdAt: base?.createdAt ?? now,
      });
      setSelectedId(null);
    },
    []
  );

  // プレイヤーから動画長が判明したら、統合が保留中なら実行する
  useEffect(() => {
    if (!project || ytDuration <= 0) return;
    if (pendingResult.current && project.duration === 0) {
      applyIntegration(pendingResult.current, ytDuration, project);
      pendingResult.current = null;
    } else if (!project.duration) {
      setProject((p) => (p ? { ...p, duration: ytDuration } : p));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytDuration, project?.videoId]);

  // 自動保存 (800msデバウンス)。空タイムラインでも音源解析結果があれば保存する
  useEffect(() => {
    if (!project) return;
    if (project.timeline.length === 0 && !project.beatGrid) return;
    const timer = setTimeout(() => saveProject(project), 800);
    return () => clearTimeout(timer);
  }, [project]);

  /** 解析実行 */
  const analyze = useCallback(
    async (opts: { force?: boolean; title?: string; artist?: string } = {}) => {
      setError("");
      const url = urlInput.trim();
      if (!url) return;

      // 保存済みプロジェクトがあればそれを開く (ユーザー編集済みコードは最優先)
      if (!opts.force) {
        const idMatch = url.match(
          /(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})|^([A-Za-z0-9_-]{11})$/
        );
        const vid = idMatch ? idMatch[1] || idMatch[2] : null;
        if (vid) {
          const saved = loadProject(vid);
          if (saved) {
            pendingResult.current = null;
            setProject(saved);
            setSelectedId(null);
            return;
          }
        }
      }

      setAnalyzeStep(0);
      const stepTimer = setInterval(() => {
        setAnalyzeStep((s) => (s >= 0 && s < ANALYZE_STEPS.length - 1 ? s + 1 : s));
      }, 2500);

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url,
            titleOverride: opts.title,
            artistOverride: opts.artist,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "解析に失敗しました");
          return;
        }
        const result = data as AnalyzeResult;
        // 同じ動画の再解析なら音源解析結果・ループ・設定を引き継ぐ
        const base = project?.videoId === result.videoId ? project : null;
        if (result.duration > 0 || (base && base.duration > 0)) {
          applyIntegration(result, result.duration || base!.duration, base);
          pendingResult.current = null;
        } else {
          // 動画長不明 → プレイヤーのdurationが取れてから統合
          pendingResult.current = result;
          const now = Date.now();
          setProject({
            videoId: result.videoId,
            videoTitle: result.videoTitle,
            channelName: result.channelName,
            duration: 0,
            songGuess: result.songGuess,
            sources: result.sources,
            progression: result.progression,
            timeline: [],
            beatGrid: null,
            analysis: null,
            debug: result.debug,
            loop: { enabled: false, start: 0, end: 0 },
            settings: { playMode: "original", chordVolume: 0.6, chordLength: 0.9, snapMode: "beat" },
            updatedAt: now,
            createdAt: now,
          });
          setSelectedId(null);
        }
      } catch {
        setError("解析リクエストに失敗しました。ネットワークを確認してください。");
      } finally {
        clearInterval(stepTimer);
        setAnalyzeStep(-1);
      }
    },
    [urlInput, project, applyIntegration]
  );

  /** 音源ファイルの解析 */
  const handleAudioFile = useCallback(
    async (file: File) => {
      if (!project) return;
      setError("");
      setAudioProgress(0);
      try {
        const { samples, sampleRate } = await decodeAudioFile(file);
        const result = await analyzeAudio(samples, sampleRate, {
          onProgress: (r) => setAudioProgress(r),
          yieldFn: () => new Promise((resolve) => setTimeout(resolve, 0)),
        });

        setProject((p) => {
          if (!p) return p;
          const dur = p.duration || result.duration;
          const hasUserEdits = p.timeline.some((e) => e.edited);
          if (hasUserEdits) {
            // ユーザー編集済みのタイムラインは崩さず、照合と情報だけ更新
            const verified = verifyWithAudio(p.timeline, result.chords);
            const needsReviewCount = verified.filter((e) => e.needsReview).length;
            return {
              ...p,
              timeline: verified,
              beatGrid: result.grid,
              audioChords: result.chords,
              audioFileName: file.name,
              analysis: {
                sourceCount: p.sources.length,
                bpm: result.grid.bpm,
                timingConfidence: result.grid.confidence >= 0.6 ? "high" : result.grid.confidence >= 0.3 ? "medium" : "low",
                needsReviewCount,
                message: `音源解析が完了しました。推定BPM: ${result.grid.bpm}。編集済みのコードはそのまま維持しています。`,
              },
            };
          }
          // 編集がなければ、実測グリッドで統合し直す
          const out = integrate({
            progression: p.progression ?? [],
            sourceCount: p.sources.length,
            duration: dur,
            audioGrid: result.grid,
            audioChords: result.chords,
          });
          return {
            ...p,
            duration: dur,
            timeline: out.timeline,
            beatGrid: out.grid,
            audioChords: result.chords,
            audioFileName: file.name,
            analysis: out.summary,
          };
        });
      } catch {
        setError(
          "音源ファイルの解析に失敗しました。対応形式 (mp3 / wav / m4a など) か確認してください。"
        );
      } finally {
        setAudioProgress(null);
      }
    },
    [project]
  );

  /** タイムライン更新の共通入口 */
  const updateTimeline = useCallback((fn: (tl: ChordEvent[]) => ChordEvent[]) => {
    setProject((p) => (p ? { ...p, timeline: normalizeTimeline(fn(p.timeline)) } : p));
  }, []);

  /** コード編集 (ユーザー確定扱いにする) */
  const editChord = useCallback(
    (id: string, patch: Partial<ChordEvent>) => {
      updateTimeline((tl) =>
        tl.map((e) =>
          e.id === id
            ? { ...e, ...patch, edited: true, source: "manual", confidence: "high", needsReview: false }
            : e
        )
      );
    },
    [updateTimeline]
  );

  /** グリッドスナップを適用した時刻 */
  const snapped = useCallback(
    (t: number) => snapTime(t, project?.beatGrid, snapMode),
    [project?.beatGrid, snapMode]
  );

  /** タイムライン境界のドラッグ移動 (スナップ適用) */
  const moveBoundary = useCallback(
    (index: number, t: number) => {
      const st = snapped(t);
      updateTimeline((tl) => {
        if (index <= 0 || index >= tl.length) return tl;
        const prev = tl[index - 1];
        const cur = tl[index];
        const clamped = Math.max(prev.start + 0.1, Math.min(cur.end - 0.1, st));
        const updated = [...tl];
        updated[index - 1] = { ...prev, end: clamped, edited: true };
        updated[index] = { ...cur, start: clamped, edited: true };
        return updated;
      });
    },
    [updateTimeline, snapped]
  );

  const setting = useCallback(
    <K extends keyof Project["settings"]>(key: K, value: Project["settings"][K]) => {
      setProject((p) => (p ? { ...p, settings: { ...p.settings, [key]: value } } : p));
    },
    []
  );

  const setLoop = useCallback((patch: Partial<Project["loop"]>) => {
    setProject((p) => (p ? { ...p, loop: { ...p.loop, ...patch } } : p));
  }, []);

  /** 「ここで次のコード」 */
  const splitAtNow = useCallback(() => {
    const t = snapped(engine.timeRef.current);
    updateTimeline((tl) => splitAt(tl, t));
  }, [engine.timeRef, updateTimeline, snapped]);

  /** 現在位置にコードを追加 */
  const addAtNow = useCallback(() => {
    const t = snapped(engine.timeRef.current);
    updateTimeline((tl) => addChordAt(tl, t, "C"));
  }, [engine.timeRef, updateTimeline, snapped]);

  /** 選択コードの開始/終了を現在位置に (スナップ適用) */
  const setStartToNow = useCallback(() => {
    if (!selectedId) return;
    const t = snapped(engine.timeRef.current);
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
  }, [selectedId, engine.timeRef, updateTimeline, snapped]);

  const setEndToNow = useCallback(() => {
    if (!selectedId) return;
    const t = snapped(engine.timeRef.current);
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
  }, [selectedId, engine.timeRef, updateTimeline, snapped]);

  /** 全コードを前後にずらす (タイミング全体補正) */
  const shiftAll = useCallback(
    (delta: number) => {
      updateTimeline((tl) => shiftTimeline(tl, delta));
    },
    [updateTimeline]
  );

  /** BPMを手動変更してグリッドを引き直す */
  const setGridBpm = useCallback((bpm: number) => {
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) return;
    setProject((p) => {
      if (!p) return p;
      const dur = p.duration || 300;
      const g = rebuildGrid(
        bpm,
        p.beatGrid?.firstDownbeat ?? 0,
        dur,
        p.beatGrid?.source ?? "assumed",
        p.beatGrid?.confidence ?? 0.5
      );
      return g ? { ...p, beatGrid: g } : p;
    });
  }, []);

  /** 最初の小節頭を現在位置に合わせてグリッドを引き直す */
  const alignDownbeatToNow = useCallback(() => {
    const t = engine.timeRef.current;
    setProject((p) => {
      if (!p || !p.beatGrid) return p;
      const dur = p.duration || 300;
      const g = rebuildGrid(p.beatGrid.bpm, t, dur, p.beatGrid.source, p.beatGrid.confidence);
      return g ? { ...p, beatGrid: g } : p;
    });
  }, [engine.timeRef]);

  /** 進行を現在のグリッドに再配置する (編集がある場合は確認) */
  const replaceOnGrid = useCallback(() => {
    setProject((p) => {
      if (!p || !p.beatGrid || !p.progression || p.progression.length === 0) return p;
      if (
        p.timeline.some((e) => e.edited) &&
        !window.confirm("編集済みのコードも含めてグリッドに再配置します。よろしいですか？")
      ) {
        return p;
      }
      let tl = placeOnGrid(p.progression, p.beatGrid, p.duration || 300);
      if (p.audioChords && p.audioChords.length > 0) tl = verifyWithAudio(tl, p.audioChords);
      return { ...p, timeline: tl };
    });
    setSelectedId(null);
  }, []);

  const manualSave = useCallback(() => {
    if (!project) return;
    saveProject(project);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
    setSavedProjects(listProjects());
  }, [project]);

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
        case "b": case "B": case "[":
          setLoop({ start: engine.timeRef.current });
          break;
        case "e": case "E": case "]":
          setLoop({ end: engine.timeRef.current });
          break;
        case "l": case "L":
          setLoop({ enabled: !loop.enabled });
          break;
        case "s": case "S":
          e.preventDefault();
          manualSave();
          break;
        case "i": case "I":
          setStartToNow();
          break;
        case "o": case "O":
          setEndToNow();
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (e.shiftKey) shiftAll(-0.1);
          else engine.seek(engine.timeRef.current - 2);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (e.shiftKey) shiftAll(0.1);
          else engine.seek(engine.timeRef.current + 2);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [project, loop.enabled, engine, splitAtNow, addAtNow, setLoop, setStartToNow, setEndToNow, shiftAll, manualSave]);

  // 表示用ボイシング (現在コード)
  const voicing = useMemo(() => {
    if (!currentChord) return { left: [], right: [] };
    return voiceChord(parseChord(currentChord.name));
  }, [currentChord]);

  const analyzing = analyzeStep >= 0;
  const noChords = project !== null && timeline.length === 0 && !analyzing;

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
            <button className="btn" onClick={() => void analyze({ force: true })} disabled={analyzing} title="保存内容を無視して最初から解析し直す">
              再解析
            </button>
          )}
        </div>
        <ThemeToggle />
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

      {audioProgress !== null && (
        <div className="analyze-progress audio-progress">
          <div className="spinner" />
          <div className="audio-progress-body">
            <p>BPM・拍位置・コード候補を解析中… {Math.round(audioProgress * 100)}%</p>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${audioProgress * 100}%` }} />
            </div>
          </div>
        </div>
      )}

      {error && <div className="alert error">{error}</div>}

      {!project && !analyzing && (
        <section className="start-screen">
          <p className="lead">
            YouTubeのJ-POPリンクを貼ると、外部コード情報や音源解析に基づくコード候補を表示し、<br />
            原曲と同期しながら「今鳴っているコード・ベース音・ピアノの押さえ方」を確認できます。
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
              <button className="btn" onClick={manualSave} title="ショートカット: S">
                {savedFlash ? "✓ 保存しました" : "保存"}
              </button>
              <button className="btn" onClick={() => { engine.pause(); setProject(null); setSelectedId(null); }}>
                閉じる
              </button>
            </div>
          </section>

          {/* 解析結果サマリー */}
          {project.analysis && !analyzing && (
            <div className={`summary-card ${timeline.length === 0 ? "summary-warn" : ""}`}>
              <p className="summary-message">{project.analysis.message}</p>
              <div className="summary-stats">
                {project.analysis.sourceCount > 0 && (
                  <span className="stat-chip">外部コードソース: {project.analysis.sourceCount}件</span>
                )}
                {project.beatGrid?.source === "audio" && (
                  <>
                    <span className="stat-chip">推定BPM: {project.beatGrid.bpm}</span>
                    <span className="stat-chip">
                      拍グリッド: {formatTime(project.beatGrid.firstDownbeat)} から
                    </span>
                  </>
                )}
                {timeline.length > 0 && (
                  <span className="stat-chip">タイミング信頼度: {project.analysis.timingConfidence}</span>
                )}
                {project.analysis.needsReviewCount > 0 && (
                  <span className="stat-chip stat-warn">⚠ 要確認: {project.analysis.needsReviewCount}箇所</span>
                )}
                {project.audioFileName && (
                  <span className="stat-chip">🎵 {project.audioFileName}</span>
                )}
              </div>
            </div>
          )}

          {/* コード候補が出せなかった場合の案内 */}
          {noChords && (
            <div className="guidance-panel">
              <h3>コード候補を表示できません</h3>
              <p className="muted">
                根拠のあるコード情報が見つからなかったため、コード進行の自動生成は行いません。
                以下のいずれかで続けてください。
              </p>
              <div className="guidance-actions">
                <div className="guidance-item">
                  <button
                    className="btn primary"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={audioProgress !== null}
                  >
                    🎵 音源ファイルをアップロードして解析
                  </button>
                  <p className="muted small">BPM・拍グリッド・コード候補を曲の音から推定します (mp3 / wav / m4a)</p>
                </div>
                <div className="guidance-item">
                  <form
                    className="research-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void analyze({ force: true, title: searchTitle, artist: searchArtist });
                    }}
                  >
                    <input
                      value={searchTitle}
                      onChange={(e) => setSearchTitle(e.target.value)}
                      placeholder="曲名"
                    />
                    <input
                      value={searchArtist}
                      onChange={(e) => setSearchArtist(e.target.value)}
                      placeholder="アーティスト名"
                    />
                    <button className="btn" type="submit" disabled={analyzing || !searchTitle.trim()}>
                      🔍 修正して再検索
                    </button>
                  </form>
                  <p className="muted small">曲名・アーティスト名の推定が違っている場合はここで直せます</p>
                </div>
                <div className="guidance-item">
                  <button className="btn" onClick={addAtNow}>＋ 手動でコードを追加</button>
                  <p className="muted small">再生しながら現在位置にコードを置いていけます (Aキー)</p>
                </div>
              </div>
            </div>
          )}

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

          {project.debug && (
            <details className="sources-detail debug-detail">
              <summary>
                🔍 検索デバッグ情報（開発用）— クエリ{project.debug.queries.length}件 /
                候補{project.debug.candidates.length}件 / 採用{project.debug.adopted.length}件 /
                {(project.debug.elapsedMs / 1000).toFixed(1)}秒
              </summary>
              <div className="debug-body">
                <p>
                  <b>推定曲名:</b> {project.debug.songTitle || "(なし)"} ／{" "}
                  <b>推定アーティスト:</b> {project.debug.artist || "(なし)"}
                </p>
                <p className="debug-label">検索クエリ:</p>
                <ul>
                  {project.debug.queries.map((q) => <li key={q}><code>{q}</code></li>)}
                </ul>
                <p className="debug-label">検索実行:</p>
                <ul>
                  {project.debug.searches.map((s, i) => (
                    <li key={i}>
                      [{s.provider}] <code>{s.query}</code> → {s.hitCount}件
                      {s.status !== undefined && <span className="muted"> (HTTP {s.status}{s.bytes ? `, ${s.bytes}B` : ""})</span>}
                      {s.usedFallback && <span className="muted"> [汎用抽出にフォールバック]</span>}
                      {s.blockedLike && <span className="debug-err"> ⚠ アクセス拒否/CAPTCHAの疑い</span>}
                      {s.error && <span className="debug-err"> エラー: {s.error}</span>}
                    </li>
                  ))}
                </ul>
                <p className="debug-label">候補URL (採用✓ / 除外✗ と理由):</p>
                <ul>
                  {project.debug.candidates.map((c) => (
                    <li key={c.url} className={c.accepted ? "" : "debug-rejected"}>
                      {c.accepted ? "✓" : "✗"} [{c.score}] {c.title || c.url}
                      <br />
                      <span className="muted small">{c.url} — {c.reasons.join(" / ")}</span>
                    </li>
                  ))}
                  {project.debug.candidates.length === 0 && <li className="muted">候補なし</li>}
                </ul>
                <p className="debug-label">取得・パース結果:</p>
                <ul>
                  {project.debug.fetched.map((f, i) => (
                    <li key={i} className={f.ok ? "" : "debug-rejected"}>
                      {f.ok ? "✓" : "✗"} {f.url} — {f.chordCount}コード
                      {f.capo !== undefined && ` / カポ${f.capo}`}
                      {f.note && ` / ${f.note}`}
                    </li>
                  ))}
                  {project.debug.fetched.length === 0 && <li className="muted">取得なし</li>}
                </ul>
                {project.debug.keyCorrections.length > 0 && (
                  <>
                    <p className="debug-label">キー・カポ補正:</p>
                    <ul>
                      {project.debug.keyCorrections.map((k, i) => <li key={i}>{k}</li>)}
                    </ul>
                  </>
                )}
              </div>
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
                  <button
                    className="btn small upload-btn"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={audioProgress !== null}
                    title="音源ファイルからBPM・拍グリッド・コード候補を解析します"
                  >
                    🎵 音源を解析
                  </button>
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
                  <button className="btn small" onClick={() => setLoop({ start: engine.timeRef.current })} title="ショートカット: B">
                    開始=現在
                  </button>
                  <button className="btn small" onClick={() => setLoop({ end: engine.timeRef.current })} title="ショートカット: E">
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
            <span className="snap-group">
              <span className="label">スナップ</span>
              {(
                [["off", "OFF"], ["beat", "拍"], ["bar", "小節"]] as [SnapMode, string][]
              ).map(([m, label]) => (
                <button
                  key={m}
                  className={`btn small ${snapMode === m ? "active" : ""}`}
                  onClick={() => setting("snapMode", m)}
                  disabled={!grid && m !== "off"}
                  title={!grid && m !== "off" ? "グリッドがありません (音源を解析すると使えます)" : ""}
                >
                  {label}
                </button>
              ))}
            </span>
            <span className="shift-group">
              <span className="label">全体シフト</span>
              <button className="btn small" onClick={() => shiftAll(-0.5)}>−0.5s</button>
              <button className="btn small" onClick={() => shiftAll(-0.1)} title="Shift+←">−0.1s</button>
              <button className="btn small" onClick={() => shiftAll(0.1)} title="Shift+→">＋0.1s</button>
              <button className="btn small" onClick={() => shiftAll(0.5)}>＋0.5s</button>
            </span>
            <span className="grid-group">
              <span className="label">BPM</span>
              <input
                type="number"
                className="bpm-input"
                min={20} max={300} step={0.1}
                value={grid?.bpm ?? ""}
                placeholder="—"
                onChange={(e) => setGridBpm(parseFloat(e.target.value))}
                title="BPMを手動変更してグリッドを引き直す"
              />
              <button
                className="btn small"
                onClick={alignDownbeatToNow}
                disabled={!grid}
                title="最初の小節頭を現在の再生位置に合わせる"
              >
                小節頭=現在
              </button>
              <button
                className="btn small"
                onClick={replaceOnGrid}
                disabled={!grid || !project.progression || project.progression.length === 0}
                title="外部コード進行を現在のグリッドに再配置する"
              >
                グリッドに再配置
              </button>
            </span>
          </div>
          <p className="muted small shortcut-hint">
            Space: 再生/停止 ・ N: ここで次のコード ・ A: コード追加 ・ B/E: ループ開始/終了 ・ L: ループON/OFF ・ S: 保存 ・ I/O: 選択コードの開始/終了=現在 ・ ←→: 2秒移動 ・ Shift+←→: 全体シフト
          </p>

          <Timeline
            timeline={timeline}
            duration={duration}
            currentTime={engine.currentTime}
            chordIndex={engine.chordIndex}
            loop={loop}
            selectedId={selectedId}
            grid={grid}
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

          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleAudioFile(file);
              e.target.value = "";
            }}
          />
        </>
      )}

      <footer className="footer muted small">
        コード候補は外部コード譜・音源解析に基づく参考情報です。信頼度と要確認マークを目安に、再生しながら確認・修正してください。
      </footer>
    </main>
  );
}

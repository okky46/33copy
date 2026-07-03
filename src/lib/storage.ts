// プロジェクトのローカル保存 (localStorage)
// 将来クラウド保存(Googleログイン)に差し替えられるよう、
// このモジュールのインターフェースだけに依存させる

import type { ChordConfidence, ChordSource, Project } from "./types";

const KEY = "otocopy.projects.v1";

function isBrowser(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 旧形式 (数値confidence・旧source名・snapMode無し) のプロジェクトを現行型に変換 */
function migrateProject(raw: any): Project {
  const migrateSource = (s: any, edited: boolean): ChordSource => {
    if (edited || s === "user" || s === "manual") return "manual";
    if (s === "consensus" || s === "merged") return "merged";
    if (s === "audio-analysis") return "audio-analysis";
    if (s === "saved") return "saved";
    if (s === "fallback") return "saved"; // 旧fallbackは保存済みユーザーデータとして残すが信頼度unknown
    return "external";
  };
  const migrateConfidence = (c: any, source: any, edited: boolean): ChordConfidence => {
    if (typeof c === "string") return c as ChordConfidence;
    if (edited) return "high";
    if (source === "fallback") return "unknown";
    if (typeof c === "number") return c >= 0.75 ? "high" : c >= 0.45 ? "medium" : "low";
    return "unknown";
  };

  const timeline = Array.isArray(raw.timeline)
    ? raw.timeline.map((e: any) => ({
        ...e,
        source: migrateSource(e.source, !!e.edited),
        confidence: migrateConfidence(e.confidence, e.source, !!e.edited),
        needsReview: !!e.needsReview || e.source === "fallback",
        evidence: e.evidence,
      }))
    : [];

  return {
    ...raw,
    timeline,
    beatGrid: raw.beatGrid ?? null,
    audioChords: raw.audioChords ?? undefined,
    analysis: raw.analysis ?? null,
    settings: {
      playMode: raw.settings?.playMode ?? "original",
      chordVolume: raw.settings?.chordVolume ?? 0.6,
      chordLength: raw.settings?.chordLength ?? 0.9,
      snapMode: raw.settings?.snapMode ?? "beat",
    },
  } as Project;
}

function loadAll(): Record<string, Project> {
  if (!isBrowser()) return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, any>;
    const out: Record<string, Project> = {};
    for (const [k, v] of Object.entries(parsed)) out[k] = migrateProject(v);
    return out;
  } catch {
    return {};
  }
}

function saveAll(projects: Record<string, Project>): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(projects));
  } catch {
    // 容量オーバー等は黙って失敗 (MVP)
  }
}

export function saveProject(project: Project): void {
  const all = loadAll();
  all[project.videoId] = { ...project, updatedAt: Date.now() };
  saveAll(all);
}

export function loadProject(videoId: string): Project | null {
  return loadAll()[videoId] ?? null;
}

export function listProjects(): Project[] {
  return Object.values(loadAll()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteProject(videoId: string): void {
  const all = loadAll();
  delete all[videoId];
  saveAll(all);
}

// ---- テーマ設定 (プロジェクトとは独立したグローバル設定) ----

const THEME_KEY = "otocopy.theme";
export type Theme = "dark" | "light";

export function loadTheme(): Theme | null {
  if (!isBrowser()) return null;
  const t = window.localStorage.getItem(THEME_KEY);
  return t === "light" || t === "dark" ? t : null;
}

export function saveTheme(theme: Theme): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // noop
  }
}

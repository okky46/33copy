// プロジェクトのローカル保存 (localStorage)
// 将来クラウド保存(Googleログイン)に差し替えられるよう、
// このモジュールのインターフェースだけに依存させる

import type { Project } from "./types";

const KEY = "otocopy.projects.v1";

function isBrowser(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

function loadAll(): Record<string, Project> {
  if (!isBrowser()) return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, Project>) : {};
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

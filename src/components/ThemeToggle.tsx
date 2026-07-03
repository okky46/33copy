"use client";

// ライト/ダークテーマ切り替え
// 初期値: localStorage → OS設定 (prefers-color-scheme) の順で決定
// (初期適用はlayout.tsxのインラインスクリプトが先に行い、ここでは状態管理と切り替えのみ)

import { useEffect, useState } from "react";
import { loadTheme, saveTheme, type Theme } from "@/lib/storage";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const stored = loadTheme();
    const initial: Theme =
      stored ??
      (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    saveTheme(next);
  };

  return (
    <button
      className="btn theme-toggle"
      onClick={toggle}
      title={theme === "dark" ? "ライトモードに切り替え" : "ダークモードに切り替え"}
      aria-label="テーマ切り替え"
    >
      {theme === "dark" ? "☀️ ライト" : "🌙 ダーク"}
    </button>
  );
}

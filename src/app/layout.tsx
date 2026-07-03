import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OtoCopy — J-POP耳コピ・ピアノ練習",
  description:
    "YouTubeリンクを貼るとコード進行を推定し、原曲と同期してピアノの押さえ方を表示する耳コピ練習支援アプリ",
};

// 初回描画前にテーマを適用してちらつきを防ぐ
const themeInitScript = `(function(){try{var t=localStorage.getItem("otocopy.theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme="dark"}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

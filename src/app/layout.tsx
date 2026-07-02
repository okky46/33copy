import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OtoCopy — J-POP耳コピ・ピアノ練習",
  description:
    "YouTubeリンクを貼るとコード進行を自動推定し、原曲と同期してピアノの押さえ方を表示する耳コピ練習支援アプリ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}

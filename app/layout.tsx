import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "xlator — 日英リアルタイム翻訳",
  description: "日本語と英語の会話を、ふたつのログへリアルタイムに整理します。",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}

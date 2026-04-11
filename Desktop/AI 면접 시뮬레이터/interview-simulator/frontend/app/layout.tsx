import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 면접 시뮬레이터",
  description: "AI가 분석하는 한국어 면접 연습 서비스",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased min-h-screen bg-slate-50">
        {children}
      </body>
    </html>
  );
}

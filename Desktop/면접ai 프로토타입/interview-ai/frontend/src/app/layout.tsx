import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AI 모의면접 — 음성 분석 기반 면접 평가",
  description: "AI와 함께하는 실전 모의면접. 음성·텍스트 멀티모달 분석으로 정확한 피드백을 받아보세요.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className={inter.className}>{children}</body>
    </html>
  );
}

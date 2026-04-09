"use client";
import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Mic, BarChart3, FileText, ArrowRight, CheckCircle } from "lucide-react";
import { useAuthStore } from "@/stores/authStore";

export default function LandingPage() {
  const { isAuthenticated } = useAuthStore();
  const router = useRouter();

  const features = [
    { icon: <Mic className="w-6 h-6" />, title: "실시간 음성 면접", desc: "AI 면접관이 질문하고 음성으로 답변하는 실전 경험" },
    { icon: <BarChart3 className="w-6 h-6" />, title: "멀티모달 분석", desc: "음성 특징 + 텍스트 내용을 동시에 분석하는 정밀 평가" },
    { icon: <FileText className="w-6 h-6" />, title: "상세 피드백 리포트", desc: "논리성·구체성·전달력 5개 항목 레이더 차트 + 개선 방향" },
  ];

  const strengths = [
    "faster-whisper 대용량 STT로 정확한 전사",
    "Kiwi 형태소 분석으로 한국어 추임새·반복 탐지",
    "STAR 구조 자동 태깅 및 점수화",
    "librosa 음향 분석으로 발화속도·피치 안정성 측정",
    "회차별 성장 추이 대시보드",
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 text-white">
      {/* 네비게이션 */}
      <nav className="flex items-center justify-between px-8 py-5 max-w-6xl mx-auto">
        <span className="text-xl font-bold text-blue-400">InterviewAI</span>
        <div className="flex gap-3">
          {isAuthenticated ? (
            <>
              <Link href="/dashboard" className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-white transition">
                대시보드
              </Link>
              <Link
                href="/interview"
                className="px-4 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 transition font-medium"
              >
                면접 시작
              </Link>
            </>
          ) : (
            <>
              <Link href="/auth/login" className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-white transition">
                로그인
              </Link>
              <Link
                href="/auth/register"
                className="px-4 py-2 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 transition font-medium"
              >
                시작하기
              </Link>
            </>
          )}
        </div>
      </nav>

      {/* 히어로 섹션 */}
      <section className="text-center px-4 pt-20 pb-16 max-w-4xl mx-auto">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-900/50 text-blue-300 text-sm mb-6">
          <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          AI 면접관이 실시간으로 대기 중
        </div>
        <h1 className="text-5xl font-bold leading-tight mb-6">
          AI와 함께하는
          <br />
          <span className="text-blue-400">실전 모의면접</span>
        </h1>
        <p className="text-xl text-slate-300 mb-10 leading-relaxed">
          음성과 텍스트를 동시에 분석하여
          <br />
          면접 실력을 객관적으로 진단하고 성장시키세요.
        </p>
        <Link
          href={isAuthenticated ? "/interview" : "/auth/register"}
          className="inline-flex items-center gap-2 px-8 py-4 bg-blue-600 hover:bg-blue-500 rounded-xl text-lg font-semibold transition shadow-lg shadow-blue-900/50"
        >
          무료로 시작하기 <ArrowRight className="w-5 h-5" />
        </Link>
      </section>

      {/* 기능 카드 */}
      <section className="max-w-5xl mx-auto px-4 pb-16 grid md:grid-cols-3 gap-6">
        {features.map((f) => (
          <div key={f.title} className="bg-white/5 rounded-2xl p-6 border border-white/10 hover:border-blue-500/40 transition">
            <div className="w-12 h-12 rounded-xl bg-blue-600/20 text-blue-400 flex items-center justify-center mb-4">
              {f.icon}
            </div>
            <h3 className="text-lg font-semibold mb-2">{f.title}</h3>
            <p className="text-slate-400 text-sm leading-relaxed">{f.desc}</p>
          </div>
        ))}
      </section>

      {/* 분석 강점 리스트 */}
      <section className="max-w-2xl mx-auto px-4 pb-24">
        <h2 className="text-2xl font-bold text-center mb-8">정밀 분석 엔진</h2>
        <div className="space-y-3">
          {strengths.map((s) => (
            <div key={s} className="flex items-center gap-3 text-slate-300">
              <CheckCircle className="w-5 h-5 text-blue-400 flex-shrink-0" />
              <span>{s}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { interviewApi } from "@/lib/api";
import { Loader2, CheckCircle, FileText, Mic, BarChart3 } from "lucide-react";

const PHASES = [
  { label: "음성 전사 중", icon: <Mic className="w-4 h-4" /> },
  { label: "텍스트 분석 중", icon: <FileText className="w-4 h-4" /> },
  { label: "점수 산출 중", icon: <BarChart3 className="w-4 h-4" /> },
];

export default function AnalyzingPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.sessionId as string;
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    // 시각적 페이즈 순환
    const phaseTimer = setInterval(() => {
      setPhaseIdx((i) => (i + 1) % PHASES.length);
    }, 4000);
    const elapsedTimer = setInterval(() => setElapsed((e) => e + 1), 1000);

    // 분석 완료 폴링 (5초 간격)
    const poll = async () => {
      try {
        const status = await interviewApi.getStatus(sessionId);
        if (status.status === "completed") {
          router.push(`/interview/${sessionId}/result`);
        } else if (status.status === "failed") {
          router.push(`/dashboard?error=analysis_failed`);
        }
      } catch { /* 폴링 실패 무시 */ }
    };
    poll();
    const pollTimer = setInterval(poll, 5000);

    return () => {
      clearInterval(phaseTimer);
      clearInterval(elapsedTimer);
      clearInterval(pollTimer);
    };
  }, [sessionId, router]);

  const formatElapsed = (s: number) =>
    s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="text-center max-w-sm w-full">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-blue-100 mb-6">
          <Loader2 className="w-10 h-10 text-blue-600 animate-spin" />
        </div>
        <h1 className="text-xl font-bold text-slate-900 mb-2">분석 중입니다</h1>
        <p className="text-slate-500 text-sm mb-8">
          AI가 답변을 분석하고 있습니다. 잠시만 기다려주세요.
        </p>

        {/* 진행 단계 */}
        <div className="space-y-3 mb-8">
          {PHASES.map((phase, i) => (
            <div
              key={phase.label}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-500 ${
                i === phaseIdx
                  ? "bg-blue-50 text-blue-700"
                  : i < phaseIdx
                  ? "text-green-600"
                  : "text-slate-400"
              }`}
            >
              {i < phaseIdx ? (
                <CheckCircle className="w-4 h-4" />
              ) : (
                <span className={i === phaseIdx ? "animate-pulse" : ""}>{phase.icon}</span>
              )}
              <span className="text-sm font-medium">{phase.label}</span>
              {i === phaseIdx && (
                <div className="ml-auto flex gap-0.5">
                  {[0, 1, 2].map((j) => (
                    <div
                      key={j}
                      className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce"
                      style={{ animationDelay: `${j * 150}ms` }}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <p className="text-xs text-slate-400">경과 시간: {formatElapsed(elapsed)}</p>
        <p className="text-xs text-slate-400 mt-1">예상 소요 시간: 1~3분</p>
      </div>
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { interviewApi } from "@/lib/api";
import type { SessionListItem } from "@/types";
import { useAuth } from "@/hooks/useAuth";
import { cn, formatScore, scoreToColor } from "@/lib/utils";
import { ArrowLeft, ChevronRight, Mic } from "lucide-react";

const STATUS_LABEL: Record<string, string> = {
  completed: "완료",
  analyzing: "분석 중",
  in_progress: "진행 중",
  failed: "실패",
};
const STATUS_COLOR: Record<string, string> = {
  completed: "text-green-600 bg-green-50",
  analyzing: "text-blue-600 bg-blue-50",
  in_progress: "text-amber-600 bg-amber-50",
  failed: "text-red-500 bg-red-50",
};

export default function HistoryPage() {
  const { isAuthenticated } = useAuth();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) return;
    interviewApi
      .listSessions()
      .then(setSessions)
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [isAuthenticated]);

  if (!isAuthenticated) return null;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-4">
          <Link href="/dashboard" className="text-slate-400 hover:text-slate-700 transition">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <h1 className="text-base font-semibold text-slate-900">면접 이력</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-3">
        {isLoading ? (
          <div className="text-center py-20 text-slate-400 animate-pulse">로딩 중...</div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-slate-500 mb-4">아직 면접 이력이 없습니다.</p>
            <Link href="/interview"
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium">
              <Mic className="w-4 h-4" /> 첫 면접 시작
            </Link>
          </div>
        ) : (
          sessions.map((s) => (
            <div key={s.id} className="bg-white rounded-2xl border border-slate-200 px-5 py-4 shadow-sm flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-semibold text-slate-800">{s.session_number}회차</span>
                  {s.job_category && <span className="text-xs text-slate-400">{s.job_category}</span>}
                </div>
                <p className="text-xs text-slate-400">
                  {new Date(s.started_at).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" })} · 답변 {s.answer_count}개
                </p>
              </div>
              <span className={cn("text-xs px-2.5 py-1 rounded-full font-medium", STATUS_COLOR[s.status])}>
                {STATUS_LABEL[s.status] || s.status}
              </span>
              {s.total_score != null && (
                <span className={cn("text-sm font-bold w-14 text-right tabular-nums", scoreToColor(s.total_score))}>
                  {formatScore(s.total_score)}점
                </span>
              )}
              {s.status === "completed" ? (
                <Link href={`/interview/${s.id}/result`}>
                  <ChevronRight className="w-5 h-5 text-slate-400 hover:text-blue-600 transition" />
                </Link>
              ) : s.status === "analyzing" ? (
                <Link href={`/interview/${s.id}/analyzing`}>
                  <ChevronRight className="w-5 h-5 text-slate-400" />
                </Link>
              ) : (
                <div className="w-5" />
              )}
            </div>
          ))
        )}
      </main>
    </div>
  );
}

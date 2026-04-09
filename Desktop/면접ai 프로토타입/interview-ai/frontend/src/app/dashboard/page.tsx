"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { dashboardApi, interviewApi } from "@/lib/api";
import type { DashboardSummary, TrendPoint, SessionListItem } from "@/types";
import { MetricCards } from "@/components/dashboard/MetricCards";
import { TrendChart } from "@/components/dashboard/TrendChart";
import { useAuth } from "@/hooks/useAuth";
import { formatScore, gradeToColor, scoreToColor } from "@/lib/utils";
import { Mic, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export default function DashboardPage() {
  const { isAuthenticated, user } = useAuth();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [trends, setTrends] = useState<TrendPoint[]>([]);
  const [recentSessions, setRecentSessions] = useState<SessionListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) return;
    const load = async () => {
      try {
        const [s, t, sessions] = await Promise.all([
          dashboardApi.getSummary(),
          dashboardApi.getTrends().then((d) => d.score_trends),
          interviewApi.listSessions(),
        ]);
        setSummary(s);
        setTrends(t);
        setRecentSessions(sessions.slice(0, 5));
      } catch { /* 미인증 등 무시 */ }
      finally { setIsLoading(false); }
    };
    load();
  }, [isAuthenticated]);

  if (!isAuthenticated) return null;

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
    failed: "text-red-600 bg-red-50",
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* 헤더 */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-lg font-bold text-slate-900">
            {user?.name}님의 대시보드
          </h1>
          <Link
            href="/interview"
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium transition"
          >
            <Mic className="w-4 h-4" /> 면접 시작
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {isLoading ? (
          <div className="text-center py-20 text-slate-400 animate-pulse">로딩 중...</div>
        ) : summary?.total_sessions === 0 ? (
          /* 첫 방문 빈 상태 */
          <div className="text-center py-20">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-blue-100 mb-5">
              <Mic className="w-10 h-10 text-blue-500" />
            </div>
            <h2 className="text-xl font-bold text-slate-800 mb-2">첫 면접을 시작해보세요!</h2>
            <p className="text-slate-500 text-sm mb-6">AI 면접관과 실전 모의면접을 진행하고<br />상세한 피드백 리포트를 받아보세요.</p>
            <Link href="/interview"
              className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-medium transition">
              <Mic className="w-5 h-5" /> 면접 시작하기
            </Link>
          </div>
        ) : (
          <>
            {/* 지표 카드 */}
            {summary && <MetricCards summary={summary} />}

            {/* 추이 차트 */}
            {trends.length > 1 && (
              <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                <h2 className="text-sm font-semibold text-slate-800 mb-4">회차별 점수 추이</h2>
                <TrendChart data={trends} />
              </div>
            )}

            {/* 최근 세션 목록 */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-800">최근 면접</h2>
                <Link href="/history" className="text-xs text-blue-600 hover:text-blue-700">전체 보기</Link>
              </div>
              <div className="divide-y divide-slate-100">
                {recentSessions.map((s) => (
                  <div key={s.id} className="px-5 py-4 flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-medium text-slate-800">{s.session_number}회차</span>
                        {s.job_category && (
                          <span className="text-xs text-slate-400">{s.job_category}</span>
                        )}
                      </div>
                      <p className="text-xs text-slate-400">
                        {new Date(s.started_at).toLocaleDateString("ko-KR")} · 답변 {s.answer_count}개
                      </p>
                    </div>
                    <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", STATUS_COLOR[s.status] || "text-slate-500")}>
                      {STATUS_LABEL[s.status] || s.status}
                    </span>
                    {s.total_score != null && (
                      <span className={cn("text-sm font-bold w-14 text-right", scoreToColor(s.total_score))}>
                        {formatScore(s.total_score)}점
                      </span>
                    )}
                    {s.status === "completed" && (
                      <Link href={`/interview/${s.id}/result`}>
                        <ChevronRight className="w-4 h-4 text-slate-400 hover:text-slate-700 transition" />
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

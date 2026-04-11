"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

const TrendChart = dynamic(() => import("@/components/TrendChart"), { ssr: false });

const API = "http://localhost:8000";

interface Session {
  id: number;
  job_title: string;
  created_at: string;
  total_score: number;
  scores: {
    logic: number;
    specificity: number;
    job_relevance: number;
    structure: number;
    delivery: number;
  };
}

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 85
      ? "bg-green-100 text-green-700"
      : score >= 70
      ? "bg-blue-100 text-blue-700"
      : score >= 55
      ? "bg-orange-100 text-orange-700"
      : "bg-red-100 text-red-700";
  return (
    <span className={`inline-block text-sm font-bold px-3 py-1 rounded-full ${color}`}>
      {score}점
    </span>
  );
}

export default function DashboardPage() {
  const [interviews, setInterviews] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [chartMode, setChartMode] = useState<"total" | "breakdown">("total");

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${API}/api/dashboard`);
        if (!res.ok) throw new Error("대시보드 조회 실패");
        const data = await res.json();
        setInterviews(data.interviews);
      } catch {
        setError("데이터를 불러오는 데 실패했습니다.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  return (
    <main className="min-h-screen bg-slate-50">
      {/* 헤더 */}
      <header className="bg-white border-b border-slate-100 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/" className="text-sm text-slate-500 hover:text-blue-600">
              ← 홈
            </Link>
            <div className="w-px h-4 bg-slate-200" />
            <h1 className="font-bold text-slate-800 text-lg">면접 대시보드</h1>
          </div>
          <Link
            href="/"
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            새 면접 시작
          </Link>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-6 text-center">
            {error}
          </div>
        ) : interviews.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-100 p-16 text-center">
            <div className="text-4xl mb-4">📊</div>
            <p className="text-slate-600 font-medium mb-2">아직 완료된 면접이 없습니다</p>
            <p className="text-slate-400 text-sm mb-6">
              면접을 진행하면 결과가 여기에 표시됩니다
            </p>
            <Link
              href="/"
              className="bg-blue-600 text-white font-medium px-6 py-2.5 rounded-xl hover:bg-blue-700 transition-colors"
            >
              첫 면접 시작하기
            </Link>
          </div>
        ) : (
          <>
            {/* 요약 스탯 */}
            <div className="grid grid-cols-3 gap-4">
              {[
                { label: "총 면접 횟수", value: `${interviews.length}회` },
                {
                  label: "평균 총점",
                  value: `${Math.round(interviews.reduce((s, i) => s + i.total_score, 0) / interviews.length)}점`,
                },
                {
                  label: "최고 점수",
                  value: `${Math.max(...interviews.map((i) => i.total_score))}점`,
                },
              ].map((s) => (
                <div
                  key={s.label}
                  className="bg-white rounded-2xl border border-slate-100 p-5 text-center"
                >
                  <p className="text-2xl font-bold text-slate-800">{s.value}</p>
                  <p className="text-xs text-slate-500 mt-1">{s.label}</p>
                </div>
              ))}
            </div>

            {/* 추이 차트 */}
            <div className="bg-white rounded-2xl border border-slate-100 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-bold text-slate-800">점수 추이</h2>
                <div className="flex gap-1 bg-slate-100 p-1 rounded-lg">
                  <button
                    onClick={() => setChartMode("total")}
                    className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                      chartMode === "total"
                        ? "bg-white text-slate-800 shadow-sm"
                        : "text-slate-500"
                    }`}
                  >
                    총점
                  </button>
                  <button
                    onClick={() => setChartMode("breakdown")}
                    className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${
                      chartMode === "breakdown"
                        ? "bg-white text-slate-800 shadow-sm"
                        : "text-slate-500"
                    }`}
                  >
                    항목별
                  </button>
                </div>
              </div>
              {interviews.length >= 2 ? (
                <TrendChart interviews={interviews} mode={chartMode} />
              ) : (
                <div className="h-40 flex items-center justify-center text-slate-400 text-sm">
                  2회 이상 면접을 완료해야 추이 차트가 표시됩니다
                </div>
              )}
            </div>

            {/* 최근 면접 목록 */}
            <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100">
                <h2 className="font-bold text-slate-800">최근 면접 기록</h2>
              </div>
              <div className="divide-y divide-slate-50">
                {interviews.map((iv, i) => (
                  <Link
                    key={iv.id}
                    href={`/result/${iv.id}`}
                    className="flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-8 h-8 bg-blue-50 text-blue-600 text-xs font-bold rounded-full flex items-center justify-center">
                        {i + 1}
                      </div>
                      <div>
                        <p className="font-medium text-slate-800">{iv.job_title}</p>
                        <p className="text-xs text-slate-400">
                          {iv.created_at?.slice(0, 16)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="hidden sm:flex gap-1">
                        {[
                          { k: "logic", label: "논" },
                          { k: "specificity", label: "구" },
                          { k: "job_relevance", label: "직" },
                          { k: "structure", label: "구조" },
                          { k: "delivery", label: "전" },
                        ].map(({ k, label }) => (
                          <span
                            key={k}
                            className="text-xs text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded"
                          >
                            {label} {(iv.scores as any)[k]}
                          </span>
                        ))}
                      </div>
                      <ScoreBadge score={iv.total_score} />
                      <span className="text-slate-300 text-sm">→</span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

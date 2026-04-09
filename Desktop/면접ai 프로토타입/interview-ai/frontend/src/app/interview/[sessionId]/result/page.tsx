"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { interviewApi } from "@/lib/api";
import type { SessionResult, TimeseriesPoint } from "@/types";
import { ScoreCard, CategoryScoreBar } from "@/components/result/ScoreCard";
import { ScoreRadarChart } from "@/components/result/RadarChart";
import { AudioAnalysisCard } from "@/components/result/AudioAnalysisCard";
import { TranscriptView } from "@/components/result/TranscriptView";
import { FeedbackSection, OverallFeedback } from "@/components/result/FeedbackSection";
import { CATEGORY_LABELS, CATEGORY_COLORS } from "@/lib/utils";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { ArrowLeft, LayoutDashboard } from "lucide-react";

export default function ResultPage() {
  const params = useParams();
  const router = useRouter();
  const sessionId = params.sessionId as string;

  const [result, setResult] = useState<SessionResult | null>(null);
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [r, ts] = await Promise.all([
          interviewApi.getResult(sessionId),
          interviewApi.getTimeseries(sessionId).then((d) => d.data).catch(() => []),
        ]);
        setResult(r);
        setTimeseries(ts);
      } catch {
        router.push("/dashboard");
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [sessionId, router]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-slate-400">리포트 로딩 중...</div>
      </div>
    );
  }
  if (!result) return null;

  const activeAnswer = result.answers[activeTab];

  return (
    <div className="min-h-screen bg-slate-50">
      {/* 헤더 */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
          <Link href="/history" className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 transition">
            <ArrowLeft className="w-4 h-4" /> 이력
          </Link>
          <h1 className="text-base font-semibold text-slate-900">면접 결과 리포트</h1>
          <Link href="/dashboard" className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 transition">
            <LayoutDashboard className="w-4 h-4" /> 대시보드
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* 메타 정보 */}
        <div className="text-sm text-slate-500">
          {new Date(result.answers[0]?.answer_id || Date.now()).toLocaleDateString("ko-KR")} ·
          {result.job_category && ` ${result.job_category} ·`} {result.session_number}회차
        </div>

        {/* 종합 점수 + 레이더 차트 */}
        <div className="grid md:grid-cols-2 gap-4">
          <ScoreCard totalScore={result.total_score} grade={result.grade} />
          <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
            <ScoreRadarChart scores={result.category_scores} />
          </div>
        </div>

        {/* 항목별 점수 바 */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold text-slate-800">항목별 점수</h2>
          {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
            <CategoryScoreBar
              key={key}
              label={label}
              score={result.category_scores[key as keyof typeof result.category_scores]}
              color={CATEGORY_COLORS[key]}
            />
          ))}
        </div>

        {/* 긴장도 시계열 차트 */}
        {timeseries.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-800 mb-4">면접 긴장도 변화</h2>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={timeseries} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="time_sec" tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}s`} />
                <YAxis domain={[0, 1]} tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
                <Tooltip formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, "긴장도"]} />
                <Line type="monotone" dataKey="tension_index" stroke="#f59e0b" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* 문항별 탭 */}
        <div>
          <div className="flex gap-2 overflow-x-auto pb-2 mb-4">
            {result.answers.map((a, i) => (
              <button
                key={a.answer_id}
                onClick={() => setActiveTab(i)}
                className={`flex-shrink-0 px-4 py-2 rounded-full text-sm font-medium transition ${
                  activeTab === i
                    ? "bg-blue-600 text-white"
                    : "bg-white text-slate-600 border border-slate-200 hover:border-blue-300"
                }`}
              >
                Q{i + 1}
              </button>
            ))}
          </div>

          {activeAnswer && (
            <div className="space-y-4">
              {/* 질문 */}
              <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
                <p className="text-xs text-slate-400 mb-1">Q{activeTab + 1}</p>
                <p className="text-slate-900 font-medium">{activeAnswer.question_text}</p>
              </div>

              {/* 전사문 */}
              <TranscriptView
                transcript={activeAnswer.transcript}
                highlightedTranscript={activeAnswer.highlighted_transcript}
                fillerCount={activeAnswer.audio_analysis?.filler_total}
              />

              {/* 음성 분석 */}
              {activeAnswer.audio_analysis && (
                <AudioAnalysisCard analysis={activeAnswer.audio_analysis} />
              )}

              {/* 항목별 피드백 */}
              <FeedbackSection answer={activeAnswer} />
            </div>
          )}
        </div>

        {/* 종합 피드백 */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800 mb-4">종합 피드백</h2>
          <OverallFeedback
            feedback={result.overall_feedback}
            strengthPoints={result.strength_points}
            suggestions={result.improvement_suggestions}
            timeseriesInsight={result.timeseries_insight}
          />
        </div>

        {/* 액션 버튼 */}
        <div className="flex gap-3 pb-8">
          <Link
            href="/interview"
            className="flex-1 py-3 text-center bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-medium text-sm transition"
          >
            다시 면접하기
          </Link>
          <Link
            href="/dashboard"
            className="flex-1 py-3 text-center bg-white border border-slate-300 hover:border-slate-400 text-slate-700 rounded-xl font-medium text-sm transition"
          >
            대시보드 보기
          </Link>
        </div>
      </main>
    </div>
  );
}

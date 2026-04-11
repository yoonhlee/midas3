"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import ScoreCard from "@/components/ScoreCard";
import LogicFeedbackCard from "@/components/LogicFeedbackCard";
import StarBreakdown from "@/components/StarBreakdown";
import DeliveryDetail from "@/components/DeliveryDetail";

const RadarChart = dynamic(() => import("@/components/RadarChart"), { ssr: false });

const API = "http://localhost:8000";

interface ResultData {
  id: number;
  job_title: string;
  jd_text: string | null;
  created_at: string;
  scores: {
    logic: number;
    specificity: number;
    job_relevance: number;
    structure: number;
    delivery: number;
    total: number;
  };
  feedbacks: Array<{
    question_id: number;
    feedback: {
      logic: any;
      specificity: any;
      job_relevance: any;
      structure: any;
      delivery: any;
      overall_comment: string;
    };
  }>;
  questions: Array<{
    id: number;
    question_text: string;
    question_type: string;
    order_num: number;
    answer_text: string | null;
  }>;
}

function GenericFeedbackCard({
  title,
  score,
  color,
  feedback,
}: {
  title: string;
  score: number;
  color: string;
  feedback: { reason: string; improvement: string };
}) {
  const textColor: Record<string, string> = {
    green: "text-green-600",
    purple: "text-purple-600",
    orange: "text-orange-600",
  };
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-slate-800 text-lg">{title}</h3>
        <div className="flex items-center gap-2">
          <span className={`text-2xl font-bold ${textColor[color] || "text-blue-600"}`}>
            {score}
          </span>
          <span className="text-slate-400 text-sm">/ 100</span>
        </div>
      </div>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">{feedback.reason}</p>
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-3">
          <p className="text-xs font-semibold text-amber-700 mb-1">개선 방향</p>
          <p className="text-sm text-amber-800">{feedback.improvement}</p>
        </div>
      </div>
    </div>
  );
}

export default function ResultPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [data, setData] = useState<ResultData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedQ, setSelectedQ] = useState(0);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${API}/api/result/${id}`);
        if (!res.ok) throw new Error("결과 조회 실패");
        setData(await res.json());
      } catch {
        setError("결과를 불러오는 데 실패했습니다.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-600 font-medium">결과를 불러오는 중...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={() => router.push("/")}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg"
          >
            처음으로
          </button>
        </div>
      </div>
    );
  }

  const { scores, feedbacks, questions } = data;

  // 선택된 질문의 피드백
  const currentQ = questions[selectedQ];
  const currentFb = feedbacks.find((f) => f.question_id === currentQ?.id)?.feedback;

  // 전체 평균 피드백 (첫 번째 피드백을 대표로 사용하거나 평균)
  const avgFeedback =
    feedbacks.length > 0 ? feedbacks[Math.floor(feedbacks.length / 2)]?.feedback : null;

  return (
    <main className="min-h-screen bg-slate-50">
      {/* 헤더 */}
      <header className="bg-white border-b border-slate-100 px-6 py-4 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div>
            <Link href="/" className="text-blue-600 text-sm hover:underline">
              ← 처음으로
            </Link>
            <h1 className="font-bold text-slate-800 mt-0.5">{data.job_title} 면접 결과</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400">{data.created_at?.slice(0, 16)}</span>
            <Link
              href="/dashboard"
              className="text-sm border border-slate-200 rounded-lg px-4 py-2 hover:border-blue-300 text-slate-600 hover:text-blue-600 transition-colors"
            >
              대시보드
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* 총점 + 레이더 */}
        <div className="bg-white rounded-2xl border border-slate-100 p-8">
          <div className="flex flex-col md:flex-row gap-8 items-center">
            {/* 총점 */}
            <div className="text-center md:w-48 shrink-0">
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-2">
                총점 (참고용)
              </p>
              <div className="w-28 h-28 mx-auto rounded-full border-4 border-blue-100 flex items-center justify-center mb-2">
                <div>
                  <span className="text-4xl font-bold text-blue-600">
                    {scores.total}
                  </span>
                  <span className="text-slate-400 text-sm">/100</span>
                </div>
              </div>
              <p className="text-xs text-slate-500">5개 항목 평균</p>
            </div>

            {/* 레이더 차트 */}
            <div className="flex-1 w-full">
              <RadarChart scores={scores} />
            </div>
          </div>

          {/* 항목별 점수 바 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-6">
            <ScoreCard label="논리성" score={scores.logic} color="blue" />
            <ScoreCard label="구체성" score={scores.specificity} color="green" />
            <ScoreCard label="직무적합성" score={scores.job_relevance} color="purple" />
            <ScoreCard label="구조완성도" score={scores.structure} color="orange" />
            <ScoreCard label="전달력" score={scores.delivery} color="pink" />
          </div>
        </div>

        {/* 종합 총평 */}
        {avgFeedback && (
          <div className="bg-blue-600 text-white rounded-2xl p-6">
            <p className="text-sm font-semibold opacity-80 mb-2">AI 종합 총평</p>
            <p className="text-base leading-relaxed">{avgFeedback.overall_comment}</p>
          </div>
        )}

        {/* 질문별 상세 피드백 */}
        <div>
          <h2 className="font-bold text-slate-800 text-xl mb-4">질문별 상세 피드백</h2>

          {/* 질문 탭 */}
          <div className="flex gap-2 mb-6 overflow-x-auto pb-1">
            {questions.map((q, i) => (
              <button
                key={q.id}
                onClick={() => setSelectedQ(i)}
                className={`shrink-0 px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                  selectedQ === i
                    ? "bg-blue-600 text-white"
                    : "bg-white text-slate-600 border border-slate-200 hover:border-blue-300"
                }`}
              >
                Q{i + 1}
              </button>
            ))}
          </div>

          {/* 선택된 질문 */}
          {currentQ && (
            <div className="space-y-4">
              {/* 질문 + 답변 */}
              <div className="bg-white rounded-2xl border border-slate-100 p-6">
                <div className="flex items-start gap-3 mb-4">
                  <span className="shrink-0 w-6 h-6 bg-blue-100 text-blue-700 text-xs font-bold rounded-full flex items-center justify-center">
                    Q
                  </span>
                  <p className="text-slate-800 font-medium">{currentQ.question_text}</p>
                </div>
                {currentQ.answer_text && (
                  <div className="bg-slate-50 rounded-xl p-4">
                    <p className="text-xs text-slate-400 mb-1">내 답변</p>
                    <p className="text-sm text-slate-700 leading-relaxed">
                      {currentQ.answer_text}
                    </p>
                  </div>
                )}
              </div>

              {/* 피드백 카드들 */}
              {currentFb ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <LogicFeedbackCard feedback={currentFb.logic} />
                  <GenericFeedbackCard
                    title="구체성"
                    score={currentFb.specificity.score}
                    color="green"
                    feedback={currentFb.specificity}
                  />
                  <GenericFeedbackCard
                    title="직무적합성"
                    score={currentFb.job_relevance.score}
                    color="purple"
                    feedback={currentFb.job_relevance}
                  />
                  <StarBreakdown
                    score={currentFb.structure.score}
                    star_breakdown={currentFb.structure.star_breakdown}
                    result_quality={currentFb.structure.result_quality}
                    reason={currentFb.structure.reason}
                    improvement={currentFb.structure.improvement}
                  />
                  <div className="lg:col-span-2">
                    <DeliveryDetail feedback={currentFb.delivery} />
                  </div>
                </div>
              ) : (
                <div className="bg-white rounded-2xl border border-slate-100 p-8 text-center text-slate-400">
                  이 질문의 피드백이 없습니다
                </div>
              )}
            </div>
          )}
        </div>

        {/* 하단 버튼 */}
        <div className="flex justify-center gap-4 pb-8">
          <Link
            href="/"
            className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-8 py-3 rounded-xl transition-colors"
          >
            다시 면접하기
          </Link>
          <Link
            href="/dashboard"
            className="border border-slate-200 hover:border-blue-300 text-slate-700 font-semibold px-8 py-3 rounded-xl transition-colors"
          >
            대시보드 보기
          </Link>
        </div>
      </div>
    </main>
  );
}

"use client";
import { cn, scoreToColor, formatScore, CATEGORY_LABELS } from "@/lib/utils";
import type { AnswerResult } from "@/types";
import { CheckCircle, TrendingUp, AlertCircle } from "lucide-react";

interface FeedbackSectionProps {
  answer: AnswerResult;
}

const SCORE_KEYS = ["logic", "specificity", "job_relevance", "structure", "delivery"] as const;

export function FeedbackSection({ answer }: FeedbackSectionProps) {
  return (
    <div className="space-y-4">
      {/* 항목별 점수 + 피드백 */}
      {SCORE_KEYS.map((key) => {
        const detail = answer.scores[key];
        if (!detail) return null;
        return (
          <div key={key} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800">{CATEGORY_LABELS[key]}</span>
              <span className={cn("text-sm font-bold", scoreToColor(detail.score))}>
                {formatScore(detail.score)}점
              </span>
            </div>
            {detail.score != null && (
              <div className="h-1.5 bg-slate-100 rounded-full mb-3">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all duration-700"
                  style={{ width: `${detail.score}%` }}
                />
              </div>
            )}
            {detail.feedback && (
              <p className="text-sm text-slate-600 leading-relaxed">{detail.feedback}</p>
            )}
          </div>
        );
      })}

      {/* 개선 방향 */}
      {answer.improvement_suggestions && answer.improvement_suggestions.length > 0 && (
        <div className="bg-amber-50 rounded-xl border border-amber-200 p-4">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-amber-600" />
            <h4 className="text-sm font-semibold text-amber-800">개선 방향</h4>
          </div>
          <ul className="space-y-2">
            {answer.improvement_suggestions.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-amber-700">
                <span className="flex-shrink-0 mt-0.5 text-amber-500">•</span>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface OverallFeedbackProps {
  feedback?: string | null;
  strengthPoints?: string[] | null;
  suggestions?: string[] | null;
  timeseriesInsight?: string | null;
}

export function OverallFeedback({ feedback, strengthPoints, suggestions, timeseriesInsight }: OverallFeedbackProps) {
  return (
    <div className="space-y-4">
      {feedback && (
        <div className="bg-blue-50 rounded-xl border border-blue-200 p-5">
          <h3 className="text-sm font-semibold text-blue-800 mb-2">종합 평가</h3>
          <p className="text-sm text-blue-700 leading-relaxed">{feedback}</p>
        </div>
      )}

      {strengthPoints && strengthPoints.length > 0 && (
        <div className="bg-green-50 rounded-xl border border-green-200 p-4">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle className="w-4 h-4 text-green-600" />
            <h4 className="text-sm font-semibold text-green-800">강점</h4>
          </div>
          <ul className="space-y-1.5">
            {strengthPoints.map((s, i) => (
              <li key={i} className="text-sm text-green-700 flex items-start gap-2">
                <span className="flex-shrink-0">✓</span>{s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {suggestions && suggestions.length > 0 && (
        <div className="bg-amber-50 rounded-xl border border-amber-200 p-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle className="w-4 h-4 text-amber-600" />
            <h4 className="text-sm font-semibold text-amber-800">개선 방향</h4>
          </div>
          <ul className="space-y-1.5">
            {suggestions.map((s, i) => (
              <li key={i} className="text-sm text-amber-700 flex items-start gap-2">
                <span className="flex-shrink-0">→</span>{s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {timeseriesInsight && (
        <div className="bg-slate-50 rounded-xl border border-slate-200 p-4">
          <h4 className="text-sm font-semibold text-slate-700 mb-1.5">긴장도 분석</h4>
          <p className="text-sm text-slate-600">{timeseriesInsight}</p>
        </div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";

interface LogicFeedback {
  score: number;
  sentence_level: string;
  context_level: string;
  reason: string;
  improvement: string;
}

export default function LogicFeedbackCard({ feedback }: { feedback: LogicFeedback }) {
  const [tab, setTab] = useState<"sentence" | "context">("sentence");

  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-slate-800 text-lg">논리성</h3>
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold text-blue-600">{feedback.score}</span>
          <span className="text-slate-400 text-sm">/ 100</span>
        </div>
      </div>

      {/* 탭 */}
      <div className="flex gap-1 bg-slate-100 p-1 rounded-lg mb-4">
        <button
          onClick={() => setTab("sentence")}
          className={`flex-1 text-sm font-medium py-1.5 rounded-md transition-colors ${
            tab === "sentence"
              ? "bg-white text-slate-800 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          문장 수준
        </button>
        <button
          onClick={() => setTab("context")}
          className={`flex-1 text-sm font-medium py-1.5 rounded-md transition-colors ${
            tab === "context"
              ? "bg-white text-slate-800 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          문맥 수준
        </button>
      </div>

      <div className="space-y-3">
        <div className="bg-blue-50 rounded-xl p-4">
          <p className="text-sm text-slate-700">
            {tab === "sentence" ? feedback.sentence_level : feedback.context_level}
          </p>
        </div>

        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
            종합 평가
          </p>
          <p className="text-sm text-slate-600">{feedback.reason}</p>
        </div>

        <div className="bg-amber-50 border border-amber-100 rounded-xl p-3">
          <p className="text-xs font-semibold text-amber-700 mb-1">개선 방향</p>
          <p className="text-sm text-amber-800">{feedback.improvement}</p>
        </div>
      </div>
    </div>
  );
}

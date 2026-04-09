"use client";
import { cn, gradeToColor, scoreToColor } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { DashboardSummary } from "@/types";

interface MetricCardsProps {
  summary: DashboardSummary;
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className={cn("text-3xl font-bold", color || "text-slate-800")}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}

const TREND_ICONS = {
  improving: <TrendingUp className="w-5 h-5 text-green-500" />,
  declining: <TrendingDown className="w-5 h-5 text-red-500" />,
  stable: <Minus className="w-5 h-5 text-slate-400" />,
};
const TREND_LABELS = { improving: "상승 추세", declining: "하락 추세", stable: "유지" };

export function MetricCards({ summary }: MetricCardsProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <StatCard label="총 면접 횟수" value={`${summary.total_sessions}회`} />
      <StatCard
        label="평균 점수"
        value={summary.avg_score != null ? `${summary.avg_score.toFixed(1)}점` : "-"}
        color={scoreToColor(summary.avg_score)}
      />
      <StatCard
        label="최고 점수"
        value={summary.best_score != null ? `${summary.best_score.toFixed(1)}점` : "-"}
        color="text-green-600"
      />
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
        <p className="text-xs text-slate-500 mb-1">추이</p>
        <div className="flex items-center gap-2">
          {TREND_ICONS[summary.score_trend]}
          <span className="text-sm font-medium text-slate-700">{TREND_LABELS[summary.score_trend]}</span>
        </div>
      </div>
    </div>
  );
}

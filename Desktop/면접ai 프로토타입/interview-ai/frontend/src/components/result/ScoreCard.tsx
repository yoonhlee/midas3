"use client";
import { cn, formatScore, scoreToColor, gradeToColor } from "@/lib/utils";

interface ScoreCardProps {
  totalScore?: number | null;
  grade?: string | null;
}

export function ScoreCard({ totalScore, grade }: ScoreCardProps) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6 text-center shadow-sm">
      <p className="text-sm text-slate-500 mb-2">종합 점수</p>
      <div className={cn("text-5xl font-bold mb-2", scoreToColor(totalScore))}>
        {formatScore(totalScore)}
      </div>
      <div className="text-slate-400 text-sm mb-3">/ 100점</div>
      {grade && (
        <span className={cn("px-3 py-1 rounded-full text-sm font-semibold", gradeToColor(grade))}>
          {grade}
        </span>
      )}
    </div>
  );
}

interface CategoryScoreBarProps {
  label: string;
  score?: number | null;
  color?: string;
}

export function CategoryScoreBar({ label, score, color = "#3b82f6" }: CategoryScoreBarProps) {
  const pct = score ?? 0;
  return (
    <div>
      <div className="flex justify-between items-center mb-1.5">
        <span className="text-sm text-slate-700">{label}</span>
        <span className={cn("text-sm font-semibold", scoreToColor(score))}>
          {formatScore(score)}
        </span>
      </div>
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

import ResultQualityBadge from "./ResultQualityBadge";

interface StarBreakdownProps {
  score: number;
  star_breakdown: {
    situation: boolean;
    task: boolean;
    action: boolean;
    result: boolean;
  };
  result_quality: {
    grade: "quantitative" | "qualitative" | "vague";
    comment: string;
    improvement: string;
  };
  reason: string;
  improvement: string;
}

const STAR_LABELS = [
  { key: "situation" as const, label: "S", title: "Situation", desc: "상황 제시" },
  { key: "task" as const, label: "T", title: "Task", desc: "역할/과제" },
  { key: "action" as const, label: "A", title: "Action", desc: "구체적 행동" },
  { key: "result" as const, label: "R", title: "Result", desc: "결과" },
];

export default function StarBreakdown({
  score,
  star_breakdown,
  result_quality,
  reason,
  improvement,
}: StarBreakdownProps) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-slate-800 text-lg">구조완성도 (STAR)</h3>
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold text-purple-600">{score}</span>
          <span className="text-slate-400 text-sm">/ 100</span>
        </div>
      </div>

      {/* S/T/A/R 체크 */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        {STAR_LABELS.map(({ key, label, title, desc }) => {
          const checked = star_breakdown[key];
          return (
            <div
              key={key}
              className={`rounded-xl p-3 text-center border ${
                checked
                  ? "bg-green-50 border-green-200"
                  : "bg-slate-50 border-slate-200"
              }`}
            >
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center mx-auto mb-1 font-bold text-sm ${
                  checked
                    ? "bg-green-500 text-white"
                    : "bg-slate-200 text-slate-400"
                }`}
              >
                {label}
              </div>
              <p className="text-xs font-semibold text-slate-600">{title}</p>
              <p className="text-xs text-slate-400">{desc}</p>
              <div className="mt-1">
                {checked ? (
                  <span className="text-green-600 text-xs">✓</span>
                ) : (
                  <span className="text-slate-300 text-xs">✗</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Result 질 등급 */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
            Result 품질
          </p>
          <ResultQualityBadge grade={result_quality.grade} />
        </div>
        <p className="text-sm text-slate-600">{result_quality.comment}</p>
        <p className="text-xs text-slate-500 mt-1">{result_quality.improvement}</p>
      </div>

      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
          종합 평가
        </p>
        <p className="text-sm text-slate-600 mb-2">{reason}</p>
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-3">
          <p className="text-xs font-semibold text-amber-700 mb-1">개선 방향</p>
          <p className="text-sm text-amber-800">{improvement}</p>
        </div>
      </div>
    </div>
  );
}

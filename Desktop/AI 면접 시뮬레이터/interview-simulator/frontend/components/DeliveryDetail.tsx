interface DeliveryFeedback {
  score: number;
  filler_count: number;
  filler_words: string[];
  length_evaluation: {
    grade: "too_short" | "optimal" | "too_long";
    char_count: number;
    content_density: "high" | "medium" | "low";
    comment: string;
  };
  repetition: {
    detected: boolean;
    surface_repetition: { detected: boolean; examples: string[] };
    semantic_repetition: { detected: boolean; examples: string[]; location: string };
    reason: string;
    improvement: string;
  };
  reason: string;
  improvement: string;
}

const LENGTH_LABEL: Record<string, { label: string; color: string }> = {
  too_short: { label: "너무 짧음", color: "text-red-600" },
  optimal: { label: "적절", color: "text-green-600" },
  too_long: { label: "너무 김", color: "text-orange-500" },
};

const DENSITY_LABEL: Record<string, { label: string; color: string }> = {
  high: { label: "높음", color: "text-green-600" },
  medium: { label: "보통", color: "text-blue-600" },
  low: { label: "낮음", color: "text-red-500" },
};

export default function DeliveryDetail({ feedback }: { feedback: DeliveryFeedback }) {
  const lenInfo = LENGTH_LABEL[feedback.length_evaluation.grade] || LENGTH_LABEL.optimal;
  const densityInfo = DENSITY_LABEL[feedback.length_evaluation.content_density] || DENSITY_LABEL.medium;

  return (
    <div className="bg-white rounded-2xl border border-slate-100 p-6">
      <div className="flex items-center justify-between mb-5">
        <h3 className="font-bold text-slate-800 text-lg">전달력</h3>
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold text-pink-600">{feedback.score}</span>
          <span className="text-slate-400 text-sm">/ 100</span>
        </div>
      </div>

      <div className="space-y-4">
        {/* 간투어 */}
        <div className="bg-slate-50 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-slate-700">간투어</span>
            <span
              className={`text-sm font-bold ${
                feedback.filler_count >= 6
                  ? "text-red-600"
                  : feedback.filler_count >= 3
                  ? "text-orange-500"
                  : "text-green-600"
              }`}
            >
              {feedback.filler_count}회
            </span>
          </div>
          {feedback.filler_words.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {feedback.filler_words.map((w, i) => (
                <span
                  key={i}
                  className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full"
                >
                  "{w}"
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-green-600">간투어가 감지되지 않았습니다</p>
          )}
        </div>

        {/* 길이 & 밀도 */}
        <div className="bg-slate-50 rounded-xl p-4">
          <p className="text-sm font-semibold text-slate-700 mb-3">답변 길이 & 밀도</p>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div className="text-center">
              <p className="text-xs text-slate-500 mb-1">글자 수</p>
              <p className="text-base font-bold text-slate-800">
                {feedback.length_evaluation.char_count}자
              </p>
            </div>
            <div className="text-center">
              <p className="text-xs text-slate-500 mb-1">길이 평가</p>
              <p className={`text-sm font-bold ${lenInfo.color}`}>{lenInfo.label}</p>
            </div>
            <div className="text-center">
              <p className="text-xs text-slate-500 mb-1">내용 밀도</p>
              <p className={`text-sm font-bold ${densityInfo.color}`}>{densityInfo.label}</p>
            </div>
          </div>
          <p className="text-sm text-slate-600">{feedback.length_evaluation.comment}</p>
        </div>

        {/* 반복 표현 */}
        <div className="bg-slate-50 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-slate-700">반복 표현</span>
            {feedback.repetition.detected ? (
              <span className="text-xs text-orange-600 bg-orange-50 border border-orange-200 px-2 py-0.5 rounded-full">
                감지됨
              </span>
            ) : (
              <span className="text-xs text-green-600 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
                없음
              </span>
            )}
          </div>

          {feedback.repetition.surface_repetition.detected && (
            <div className="mb-2">
              <p className="text-xs text-slate-500 mb-1">표현 반복</p>
              <div className="flex flex-wrap gap-1">
                {feedback.repetition.surface_repetition.examples.map((ex, i) => (
                  <span
                    key={i}
                    className="text-xs bg-red-50 text-red-700 px-2 py-0.5 rounded"
                  >
                    {ex}
                  </span>
                ))}
              </div>
            </div>
          )}

          {feedback.repetition.semantic_repetition.detected && (
            <div className="mb-2">
              <p className="text-xs text-slate-500 mb-1">
                의미 중복{" "}
                {feedback.repetition.semantic_repetition.location && (
                  <span className="text-slate-400">
                    ({feedback.repetition.semantic_repetition.location})
                  </span>
                )}
              </p>
              <div className="flex flex-wrap gap-1">
                {feedback.repetition.semantic_repetition.examples.map((ex, i) => (
                  <span
                    key={i}
                    className="text-xs bg-yellow-50 text-yellow-700 px-2 py-0.5 rounded"
                  >
                    {ex}
                  </span>
                ))}
              </div>
            </div>
          )}

          <p className="text-sm text-slate-600">{feedback.repetition.reason}</p>
        </div>

        {/* 종합 */}
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
            종합 평가
          </p>
          <p className="text-sm text-slate-600 mb-2">{feedback.reason}</p>
          <div className="bg-amber-50 border border-amber-100 rounded-xl p-3">
            <p className="text-xs font-semibold text-amber-700 mb-1">개선 방향</p>
            <p className="text-sm text-amber-800">{feedback.improvement}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

interface Props {
  label: string;
  score: number;
  color?: string;
}

export default function ScoreCard({ label, score, color = "blue" }: Props) {
  const colorMap: Record<string, string> = {
    blue: "bg-blue-50 text-blue-700 border-blue-100",
    green: "bg-green-50 text-green-700 border-green-100",
    purple: "bg-purple-50 text-purple-700 border-purple-100",
    orange: "bg-orange-50 text-orange-700 border-orange-100",
    pink: "bg-pink-50 text-pink-700 border-pink-100",
  };
  const barMap: Record<string, string> = {
    blue: "bg-blue-500",
    green: "bg-green-500",
    purple: "bg-purple-500",
    orange: "bg-orange-500",
    pink: "bg-pink-500",
  };

  const grade =
    score >= 85 ? "우수" : score >= 70 ? "양호" : score >= 55 ? "보통" : "미흡";
  const gradeColor =
    score >= 85
      ? "text-green-600"
      : score >= 70
      ? "text-blue-600"
      : score >= 55
      ? "text-orange-500"
      : "text-red-500";

  return (
    <div className={`rounded-xl border p-4 ${colorMap[color]}`}>
      <div className="flex justify-between items-center mb-2">
        <span className="text-sm font-semibold">{label}</span>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${gradeColor}`}>{grade}</span>
          <span className="text-lg font-bold">{score}</span>
        </div>
      </div>
      <div className="w-full bg-white/60 rounded-full h-2">
        <div
          className={`${barMap[color]} h-2 rounded-full transition-all duration-700`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  );
}

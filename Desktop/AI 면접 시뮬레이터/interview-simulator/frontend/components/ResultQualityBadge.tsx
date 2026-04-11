type Grade = "quantitative" | "qualitative" | "vague";

const CONFIG: Record<Grade, { label: string; className: string }> = {
  quantitative: {
    label: "정량적",
    className: "bg-green-100 text-green-700 border border-green-200",
  },
  qualitative: {
    label: "정성적",
    className: "bg-blue-100 text-blue-700 border border-blue-200",
  },
  vague: {
    label: "모호",
    className: "bg-red-100 text-red-700 border border-red-200",
  },
};

export default function ResultQualityBadge({ grade }: { grade: Grade }) {
  const config = CONFIG[grade] || CONFIG.vague;
  return (
    <span
      className={`inline-block text-xs font-semibold px-2.5 py-0.5 rounded-full ${config.className}`}
    >
      {config.label}
    </span>
  );
}

"use client";
import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Tooltip,
} from "recharts";
import { CATEGORY_LABELS } from "@/lib/utils";

interface RadarChartProps {
  scores: {
    logic?: number | null;
    specificity?: number | null;
    job_relevance?: number | null;
    structure?: number | null;
    delivery?: number | null;
  };
}

export function ScoreRadarChart({ scores }: RadarChartProps) {
  const data = [
    { subject: "논리성", score: scores.logic ?? 0, fullMark: 100 },
    { subject: "구체성", score: scores.specificity ?? 0, fullMark: 100 },
    { subject: "직무\n적합성", score: scores.job_relevance ?? 0, fullMark: 100 },
    { subject: "구조\n완성도", score: scores.structure ?? 0, fullMark: 100 },
    { subject: "전달력", score: scores.delivery ?? 0, fullMark: 100 },
  ];

  return (
    <ResponsiveContainer width="100%" height={260}>
      <RadarChart data={data} margin={{ top: 10, right: 30, bottom: 10, left: 30 }}>
        <PolarGrid stroke="#e2e8f0" />
        <PolarAngleAxis dataKey="subject" tick={{ fontSize: 12, fill: "#64748b" }} />
        <PolarRadiusAxis angle={90} domain={[0, 100]} tick={false} axisLine={false} />
        <Radar
          name="점수"
          dataKey="score"
          stroke="#3b82f6"
          fill="#3b82f6"
          fillOpacity={0.2}
          strokeWidth={2}
        />
        <Tooltip
          formatter={(v: number) => [`${v.toFixed(1)}점`, "점수"]}
          contentStyle={{ borderRadius: "8px", border: "1px solid #e2e8f0", fontSize: "13px" }}
        />
      </RadarChart>
    </ResponsiveContainer>
  );
}

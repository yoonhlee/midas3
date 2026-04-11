"use client";

import {
  Radar,
  RadarChart as RechartsRadarChart,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

interface Props {
  scores: {
    logic: number;
    specificity: number;
    job_relevance: number;
    structure: number;
    delivery: number;
  };
}

export default function RadarChart({ scores }: Props) {
  const data = [
    { subject: "논리성", value: scores.logic },
    { subject: "구체성", value: scores.specificity },
    { subject: "직무적합성", value: scores.job_relevance },
    { subject: "구조완성도", value: scores.structure },
    { subject: "전달력", value: scores.delivery },
  ];

  return (
    <ResponsiveContainer width="100%" height={280}>
      <RechartsRadarChart data={data}>
        <PolarGrid stroke="#e2e8f0" />
        <PolarAngleAxis
          dataKey="subject"
          tick={{ fill: "#64748b", fontSize: 13, fontWeight: 500 }}
        />
        <Radar
          name="점수"
          dataKey="value"
          stroke="#2563eb"
          fill="#2563eb"
          fillOpacity={0.2}
          strokeWidth={2}
        />
        <Tooltip
          formatter={(v: any) => [`${v}점`, "점수"]}
          contentStyle={{
            borderRadius: "8px",
            border: "1px solid #e2e8f0",
            fontSize: "13px",
          }}
        />
      </RechartsRadarChart>
    </ResponsiveContainer>
  );
}

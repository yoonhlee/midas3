"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface Session {
  id: number;
  job_title: string;
  created_at: string;
  total_score: number;
  scores: {
    logic: number;
    specificity: number;
    job_relevance: number;
    structure: number;
    delivery: number;
  };
}

interface Props {
  interviews: Session[];
  mode: "total" | "breakdown";
}

const COLORS = {
  total: "#2563eb",
  logic: "#2563eb",
  specificity: "#16a34a",
  job_relevance: "#9333ea",
  structure: "#ea580c",
  delivery: "#db2777",
};

const LABELS = {
  logic: "논리성",
  specificity: "구체성",
  job_relevance: "직무적합성",
  structure: "구조완성도",
  delivery: "전달력",
};

export default function TrendChart({ interviews, mode }: Props) {
  const reversed = [...interviews].reverse();

  const data = reversed.map((iv, i) => ({
    name: `${i + 1}회차`,
    total: iv.total_score,
    logic: iv.scores.logic,
    specificity: iv.scores.specificity,
    job_relevance: iv.scores.job_relevance,
    structure: iv.scores.structure,
    delivery: iv.scores.delivery,
    job: iv.job_title,
  }));

  if (mode === "total") {
    return (
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
          <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#94a3b8" }} />
          <YAxis domain={[0, 100]} tick={{ fontSize: 12, fill: "#94a3b8" }} />
          <Tooltip
            formatter={(v: any) => [`${v}점`]}
            labelFormatter={(l, p) => `${l} - ${p[0]?.payload?.job}`}
            contentStyle={{ borderRadius: "8px", border: "1px solid #e2e8f0", fontSize: "12px" }}
          />
          <Line
            type="monotone"
            dataKey="total"
            name="총점"
            stroke={COLORS.total}
            strokeWidth={2.5}
            dot={{ r: 4 }}
            activeDot={{ r: 6 }}
          />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#94a3b8" }} />
        <YAxis domain={[0, 100]} tick={{ fontSize: 12, fill: "#94a3b8" }} />
        <Tooltip
          contentStyle={{ borderRadius: "8px", border: "1px solid #e2e8f0", fontSize: "12px" }}
          formatter={(v: any, name: any) => [`${v}점`, (LABELS as any)[name] || name]}
        />
        <Legend
          formatter={(v) => (LABELS as any)[v] || v}
          wrapperStyle={{ fontSize: "12px" }}
        />
        {(["logic", "specificity", "job_relevance", "structure", "delivery"] as const).map(
          (k) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              name={k}
              stroke={COLORS[k]}
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          )
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}

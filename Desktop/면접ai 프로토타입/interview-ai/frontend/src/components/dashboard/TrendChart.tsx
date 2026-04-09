"use client";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import type { TrendPoint } from "@/types";
import { CATEGORY_LABELS, CATEGORY_COLORS } from "@/lib/utils";

interface TrendChartProps {
  data: TrendPoint[];
}

export function TrendChart({ data }: TrendChartProps) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis dataKey="session_number" tickFormatter={(v) => `${v}회차`} tick={{ fontSize: 11 }} />
        <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v: number, name: string) => [`${v.toFixed(1)}점`, name]} />
        <Legend wrapperStyle={{ fontSize: "12px" }} />
        <Line type="monotone" dataKey="total_score" stroke="#1e40af" strokeWidth={2.5} name="총점" dot={{ r: 4 }} />
        {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
          <Line
            key={key}
            type="monotone"
            dataKey={`${key}_score`}
            stroke={CATEGORY_COLORS[key]}
            strokeWidth={1.5}
            name={label}
            dot={false}
            strokeDasharray="4 2"
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

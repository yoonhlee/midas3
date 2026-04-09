import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatScore(score?: number | null): string {
  if (score == null) return "-";
  return score.toFixed(1);
}

export function scoreToColor(score?: number | null): string {
  if (score == null) return "text-gray-400";
  if (score >= 85) return "text-green-500";
  if (score >= 70) return "text-blue-500";
  if (score >= 55) return "text-yellow-500";
  return "text-red-500";
}

export function formatDuration(sec?: number | null): string {
  if (sec == null) return "-";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}분 ${s}초` : `${s}초`;
}

export function formatPercent(ratio?: number | null): string {
  if (ratio == null) return "-";
  return `${(ratio * 100).toFixed(1)}%`;
}

export function gradeToColor(grade?: string | null): string {
  if (!grade) return "bg-gray-100 text-gray-600";
  if (grade.startsWith("A")) return "bg-green-100 text-green-700";
  if (grade.startsWith("B")) return "bg-blue-100 text-blue-700";
  if (grade.startsWith("C")) return "bg-yellow-100 text-yellow-700";
  return "bg-red-100 text-red-700";
}

export const CATEGORY_LABELS: Record<string, string> = {
  logic: "논리성",
  specificity: "구체성",
  job_relevance: "직무 적합성",
  structure: "구조 완성도",
  delivery: "전달력",
};

export const CATEGORY_COLORS: Record<string, string> = {
  logic: "#6366f1",
  specificity: "#8b5cf6",
  job_relevance: "#06b6d4",
  structure: "#10b981",
  delivery: "#f59e0b",
};

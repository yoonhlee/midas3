"use client";
import { cn } from "@/lib/utils";

interface InterviewProgressProps {
  current: number;
  total: number;
}

export function InterviewProgress({ current, total }: InterviewProgressProps) {
  return (
    <div className="w-full">
      <div className="flex justify-between text-sm text-slate-500 mb-2">
        <span>진행 중</span>
        <span className="font-medium text-slate-700">{current} / {total}</span>
      </div>
      <div className="flex gap-1.5">
        {Array.from({ length: total }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "h-2 flex-1 rounded-full transition-all duration-500",
              i < current ? "bg-blue-500" : i === current - 1 ? "bg-blue-400" : "bg-slate-200"
            )}
          />
        ))}
      </div>
    </div>
  );
}

"use client";
import { formatDuration, formatPercent, formatScore } from "@/lib/utils";
import type { AudioAnalysis } from "@/types";

interface AudioAnalysisCardProps {
  analysis: AudioAnalysis;
}

function StatItem({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="bg-slate-50 rounded-xl p-3">
      <p className="text-xs text-slate-500 mb-0.5">{label}</p>
      <p className="text-sm font-semibold text-slate-800">{value}</p>
      {note && <p className="text-xs text-slate-400 mt-0.5">{note}</p>}
    </div>
  );
}

export function AudioAnalysisCard({ analysis }: AudioAnalysisCardProps) {
  const fillerPct = analysis.filler_ratio != null ? (analysis.filler_ratio * 100).toFixed(1) + "%" : "-";
  const speechRateStatus =
    analysis.speech_rate_wps == null
      ? ""
      : analysis.speech_rate_wps < 3.0
      ? "느림"
      : analysis.speech_rate_wps > 4.5
      ? "빠름"
      : "적정";

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-800 mb-4">음성 분석 상세</h3>
      <div className="grid grid-cols-2 gap-3">
        <StatItem label="답변 시간" value={formatDuration(analysis.duration_sec)} note="권장: 40~90초" />
        <StatItem
          label="발화 속도"
          value={analysis.speech_rate_wps != null ? `${analysis.speech_rate_wps.toFixed(1)} 어절/초` : "-"}
          note={speechRateStatus}
        />
        <StatItem label="추임새 비율" value={fillerPct} note="3% 미만 우수" />
        <StatItem
          label="pause 비율"
          value={formatPercent(analysis.pause_ratio)}
          note="15~30% 적정"
        />
        <StatItem
          label="확신형 종결어미"
          value={formatPercent(analysis.confident_ending_ratio)}
          note="높을수록 자신감"
        />
        <StatItem
          label="말끝 흐림"
          value={formatPercent(analysis.end_of_sentence_rms_drop)}
          note="30% 미만 적정"
        />
      </div>
    </div>
  );
}

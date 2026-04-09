"use client";

interface TranscriptViewProps {
  transcript?: string | null;
  highlightedTranscript?: string | null;
  fillerCount?: number | null;
}

export function TranscriptView({ transcript, highlightedTranscript, fillerCount }: TranscriptViewProps) {
  const html = highlightedTranscript || transcript || "(전사문 없음)";

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-800">답변 전사문</h3>
        {fillerCount != null && fillerCount > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700">
            추임새 {fillerCount}회
          </span>
        )}
      </div>
      <p
        className="text-sm text-slate-700 leading-relaxed"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {fillerCount != null && fillerCount > 0 && (
        <p className="text-xs text-slate-400 mt-3">
          <span className="inline-block px-1 bg-yellow-100 text-yellow-700 rounded">노란 형광</span>으로 표시된 부분이 추임새입니다.
        </p>
      )}
    </div>
  );
}

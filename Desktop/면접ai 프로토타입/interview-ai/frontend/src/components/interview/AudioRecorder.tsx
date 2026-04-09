"use client";
import { useEffect, useRef } from "react";
import { Mic, Square, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAudioRecorder } from "@/hooks/useAudioRecorder";

interface AudioRecorderProps {
  onRecordingComplete: (blob: Blob, durationSec: number) => void;
  disabled?: boolean;
}

export function AudioRecorder({ onRecordingComplete, disabled }: AudioRecorderProps) {
  const {
    isRecording, isPaused, duration, audioBlob, waveformData,
    startRecording, stopRecording, pauseRecording, resumeRecording, error,
  } = useAudioRecorder();

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 완료 처리
  useEffect(() => {
    if (audioBlob && !isRecording) {
      onRecordingComplete(audioBlob, duration);
    }
  }, [audioBlob]); // eslint-disable-line react-hooks/exhaustive-deps

  // 웨이브폼 캔버스 렌더링
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !waveformData) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);

    const barWidth = 3;
    const gap = 2;
    const totalBars = Math.floor(width / (barWidth + gap));
    const step = Math.floor(waveformData.length / totalBars);

    ctx.fillStyle = "#3b82f6";
    for (let i = 0; i < totalBars; i++) {
      const sample = waveformData[i * step] ?? 128;
      const barHeight = ((sample - 128) / 128) * (height / 2);
      const x = i * (barWidth + gap);
      ctx.fillRect(x, height / 2 - Math.abs(barHeight), barWidth, Math.max(2, Math.abs(barHeight) * 2));
    }
  }, [waveformData]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  return (
    <div className="flex flex-col items-center gap-5">
      {/* 웨이브폼 */}
      <div className="w-full h-20 bg-slate-100 rounded-xl overflow-hidden flex items-center justify-center">
        {isRecording && !isPaused ? (
          <canvas ref={canvasRef} width={400} height={80} className="w-full h-full" />
        ) : (
          <div className="flex items-center gap-1">
            {Array.from({ length: 32 }).map((_, i) => (
              <div
                key={i}
                className="w-1 bg-slate-300 rounded-full"
                style={{ height: `${12 + Math.sin(i * 0.4) * 10}px` }}
              />
            ))}
          </div>
        )}
      </div>

      {/* 타이머 */}
      <div className="text-3xl font-mono font-bold text-slate-700 tabular-nums">
        {formatTime(duration)}
        {duration >= 90 && <span className="text-sm font-sans text-amber-500 ml-2">권장 시간 초과</span>}
      </div>

      {/* 컨트롤 */}
      <div className="flex items-center gap-4">
        {!isRecording ? (
          <button
            onClick={startRecording}
            disabled={disabled}
            className={cn(
              "w-16 h-16 rounded-full flex items-center justify-center transition shadow-lg",
              "bg-red-500 hover:bg-red-600 text-white",
              disabled && "opacity-50 cursor-not-allowed",
              isRecording && "animate-pulse-ring"
            )}
            title="녹음 시작"
          >
            <Mic className="w-7 h-7" />
          </button>
        ) : (
          <>
            <button
              onClick={isPaused ? resumeRecording : pauseRecording}
              className="w-12 h-12 rounded-full bg-slate-200 hover:bg-slate-300 text-slate-700 flex items-center justify-center transition"
              title={isPaused ? "재개" : "일시정지"}
            >
              {isPaused ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
            </button>
            <div className="w-4 h-4 rounded-full bg-red-500 animate-pulse" />
            <button
              onClick={stopRecording}
              className="w-16 h-16 rounded-full bg-slate-800 hover:bg-slate-900 text-white flex items-center justify-center transition shadow-lg"
              title="답변 완료"
            >
              <Square className="w-6 h-6 fill-white" />
            </button>
          </>
        )}
      </div>

      {isRecording && (
        <p className="text-sm text-slate-500">
          {isPaused ? "일시정지됨 — 재개하거나 완료하세요" : "녹음 중... 답변이 끝나면 ■ 버튼을 누르세요"}
        </p>
      )}
      {!isRecording && !audioBlob && (
        <p className="text-sm text-slate-500">마이크 버튼을 눌러 답변을 시작하세요</p>
      )}
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}

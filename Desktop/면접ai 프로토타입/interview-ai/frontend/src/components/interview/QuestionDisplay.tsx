"use client";
import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import type { Question } from "@/types";

interface QuestionDisplayProps {
  question: Question;
  autoPlayTTS?: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  경험: "경험",
  역량: "역량",
  상황: "상황",
  직무지식: "직무지식",
  인성: "인성",
};

const CATEGORY_COLORS: Record<string, string> = {
  경험: "bg-blue-100 text-blue-700",
  역량: "bg-purple-100 text-purple-700",
  상황: "bg-amber-100 text-amber-700",
  직무지식: "bg-green-100 text-green-700",
  인성: "bg-pink-100 text-pink-700",
};

export function QuestionDisplay({ question, autoPlayTTS = true }: QuestionDisplayProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (!question.tts_url || !autoPlayTTS) return;
    const baseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    const fullUrl = question.tts_url.startsWith("http")
      ? question.tts_url
      : `${baseUrl}${question.tts_url}`;

    const audio = new Audio(fullUrl);
    audioRef.current = audio;
    audio.onplay = () => setIsPlaying(true);
    audio.onended = () => setIsPlaying(false);
    audio.onerror = () => setIsPlaying(false);
    audio.play().catch(() => setIsPlaying(false));

    return () => {
      audio.pause();
      audio.src = "";
    };
  }, [question.question_id, question.tts_url, autoPlayTTS]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().catch(() => {});
    }
  };

  const colorClass = CATEGORY_COLORS[question.category] || "bg-slate-100 text-slate-700";

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <span className={`text-xs font-medium px-3 py-1 rounded-full ${colorClass}`}>
          {CATEGORY_LABELS[question.category] ?? question.category}
          {question.expected_star_applicable && " · STAR 권장"}
        </span>
        {question.tts_url && (
          <button
            onClick={togglePlay}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
            title={isPlaying ? "음성 중지" : "음성 재생"}
          >
            {isPlaying ? <Volume2 className="w-5 h-5 text-blue-500" /> : <VolumeX className="w-5 h-5" />}
          </button>
        )}
      </div>

      <div className="flex gap-3">
        {/* AI 아바타 */}
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
          AI
        </div>
        <div className="flex-1">
          <p className="text-sm text-slate-500 mb-1">면접관 질문</p>
          <p className="text-slate-900 font-medium leading-relaxed text-lg">
            {question.question_text}
          </p>
        </div>
      </div>
    </div>
  );
}

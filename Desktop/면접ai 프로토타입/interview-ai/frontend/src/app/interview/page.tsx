"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { useInterview } from "@/hooks/useInterview";
import { useInterviewStore } from "@/stores/interviewStore";
import InterviewRoom from "@/components/interview/InterviewRoom";
import { Mic } from "lucide-react";

const JOB_CATEGORIES = ["데이터분석", "개발", "기획", "마케팅", "영업", "인사", "운영"];

export default function InterviewPage() {
  const { isAuthenticated } = useAuth();
  const router = useRouter();
  const store = useInterviewStore();
  const { startNewInterview, isLoading, apiError } = useInterview();
  const [jobCategory, setJobCategory] = useState("");
  const [step, setStep] = useState<"setup" | "interview">("setup");

  useEffect(() => {
    if (store.currentSession && !store.isFinished) {
      setStep("interview");
    }
  }, [store.currentSession, store.isFinished]);

  if (!isAuthenticated) return null;
  if (step === "interview") return <InterviewRoom />;

  const handleStart = async () => {
    store.reset();
    await startNewInterview(jobCategory || undefined);
    setStep("interview");
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600 text-white mb-4">
            <Mic className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">면접 시작 준비</h1>
          <p className="text-slate-500 mt-2 text-sm">조용한 환경에서 마이크가 작동하는지 확인해주세요.</p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5 shadow-sm">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">지원 직무 선택</label>
            <select
              value={jobCategory}
              onChange={(e) => setJobCategory(e.target.value)}
              className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm bg-white"
            >
              <option value="">전체 직무 (무작위 선택)</option>
              {JOB_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className="bg-slate-50 rounded-xl p-4 space-y-2 text-sm text-slate-600">
            <p className="font-medium text-slate-800">면접 안내</p>
            <ul className="space-y-1 list-disc list-inside">
              <li>질문 {5}개가 순서대로 진행됩니다</li>
              <li>각 질문은 TTS 음성으로 자동 재생됩니다</li>
              <li>권장 답변 시간: <strong>40~90초</strong></li>
              <li>마이크 버튼을 눌러 녹음을 시작하세요</li>
            </ul>
          </div>

          {apiError && (
            <p className="text-sm text-red-600 text-center">{apiError}</p>
          )}

          <button
            onClick={handleStart}
            disabled={isLoading}
            className="w-full py-3.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl font-semibold transition text-sm"
          >
            {isLoading ? "준비 중..." : "면접 시작하기"}
          </button>
        </div>
      </div>
    </div>
  );
}

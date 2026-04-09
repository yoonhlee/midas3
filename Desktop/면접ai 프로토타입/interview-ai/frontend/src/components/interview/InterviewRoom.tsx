"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { useInterviewStore } from "@/stores/interviewStore";
import { useInterview } from "@/hooks/useInterview";
import { AudioRecorder } from "./AudioRecorder";
import { QuestionDisplay } from "./QuestionDisplay";
import { InterviewProgress } from "./InterviewProgress";

export default function InterviewRoom() {
  const router = useRouter();
  const store = useInterviewStore();
  const { submitAnswer, endInterview, apiError } = useInterview();
  const [showEndConfirm, setShowEndConfirm] = useState(false);

  const { currentSession, currentQuestion, questionIndex, totalQuestions, isUploading, isFinished } = store;

  // 세션 없으면 홈으로
  useEffect(() => {
    if (!currentSession) router.push("/");
  }, [currentSession, router]);

  // 면접 완료 → 분석 대기 화면으로
  useEffect(() => {
    if (isFinished && currentSession) {
      router.push(`/interview/${currentSession.id}/analyzing`);
    }
  }, [isFinished, currentSession, router]);

  if (!currentSession || !currentQuestion) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-slate-400">로딩 중...</div>
      </div>
    );
  }

  const handleRecordingComplete = async (blob: Blob, durationSec: number) => {
    await submitAnswer(blob, durationSec);
  };

  const handleEndInterview = async () => {
    setShowEndConfirm(false);
    await endInterview();
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* 헤더 */}
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-base font-semibold text-slate-800">AI 모의면접</h1>
            <button
              onClick={() => setShowEndConfirm(true)}
              className="text-sm text-slate-400 hover:text-red-500 transition"
            >
              면접 종료
            </button>
          </div>
          <InterviewProgress current={questionIndex + 1} total={totalQuestions} />
        </div>
      </header>

      {/* 메인 컨텐츠 */}
      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-8 space-y-6">
        {/* 질문 표시 */}
        <QuestionDisplay question={currentQuestion} autoPlayTTS />

        {/* 답변 안내 */}
        <div className="bg-blue-50 rounded-xl px-4 py-3 text-sm text-blue-700">
          💡 <strong>팁:</strong>{" "}
          {currentQuestion.expected_star_applicable
            ? "STAR 구조(상황→과제→행동→결과)로 답변하면 높은 점수를 받을 수 있어요."
            : "핵심을 먼저 말하고, 구체적인 이유와 근거를 이어서 설명해 주세요."}
        </div>

        {/* 녹음기 */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
          {isUploading ? (
            <div className="text-center py-8">
              <div className="inline-flex items-center gap-2 text-blue-600">
                <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                <span>업로드 중...</span>
              </div>
            </div>
          ) : (
            <AudioRecorder onRecordingComplete={handleRecordingComplete} disabled={isUploading} />
          )}
        </div>

        {apiError && (
          <div className="flex items-center gap-2 px-4 py-3 bg-red-50 rounded-xl text-red-700 text-sm">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            {apiError}
          </div>
        )}
      </main>

      {/* 종료 확인 모달 */}
      {showEndConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl">
            <h3 className="font-semibold text-slate-900 mb-2">면접을 종료할까요?</h3>
            <p className="text-sm text-slate-500 mb-5">
              지금까지 녹음된 답변으로 분석이 진행됩니다.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowEndConfirm(false)}
                className="flex-1 py-2.5 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-50 transition"
              >
                계속 진행
              </button>
              <button
                onClick={handleEndInterview}
                className="flex-1 py-2.5 rounded-lg bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition"
              >
                종료하기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

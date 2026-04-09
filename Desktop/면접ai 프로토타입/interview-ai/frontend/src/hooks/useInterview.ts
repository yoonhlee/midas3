/**
 * 면접 세션 진행 훅
 */
"use client";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { interviewApi } from "@/lib/api";
import { useInterviewStore } from "@/stores/interviewStore";
import type { Question } from "@/types";

export function useInterview() {
  const router = useRouter();
  const store = useInterviewStore();
  const [isLoading, setIsLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  /** 새 세션 생성 후 면접 시작 */
  const startNewInterview = useCallback(
    async (jobCategory?: string) => {
      setIsLoading(true);
      setApiError(null);
      try {
        const session = await interviewApi.createSession(jobCategory);
        store.setSession(session);
        const firstQuestion = await interviewApi.startInterview(session.id);
        store.setCurrentQuestion(firstQuestion, 5);
        router.push(`/interview`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "면접 시작 실패";
        setApiError(msg);
      } finally {
        setIsLoading(false);
      }
    },
    [router, store]
  );

  /** 답변 업로드 후 다음 질문으로 이동 */
  const submitAnswer = useCallback(
    async (audioBlob: Blob, duration: number): Promise<boolean> => {
      const { currentSession, currentQuestion } = store;
      if (!currentSession || !currentQuestion) return false;

      store.setUploading(true);
      setApiError(null);
      try {
        const result = await interviewApi.uploadAnswer(
          currentSession.id,
          currentQuestion.question_order,
          audioBlob,
          duration
        );

        if (result.is_last_question) {
          // 마지막 답변 → 면접 종료
          await interviewApi.finishInterview(currentSession.id);
          store.finishSession();
          return true;
        } else if (result.next_question) {
          store.setCurrentQuestion(result.next_question);
          // TTS 자동 재생
          if (result.next_question.tts_url) {
            playTTS(result.next_question.tts_url);
          }
        }
        return false;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "답변 업로드 실패";
        setApiError(msg);
        return false;
      } finally {
        store.setUploading(false);
      }
    },
    [store]
  );

  /** 면접 조기 종료 */
  const endInterview = useCallback(async () => {
    const { currentSession } = store;
    if (!currentSession) return;
    try {
      await interviewApi.finishInterview(currentSession.id);
      store.finishSession();
    } catch {
      /* 실패해도 세션 종료 처리 */
      store.finishSession();
    }
  }, [store]);

  return {
    isLoading,
    apiError,
    startNewInterview,
    submitAnswer,
    endInterview,
  };
}

/** TTS 오디오 재생 */
export function playTTS(url: string): HTMLAudioElement {
  const audio = new Audio(url);
  audio.play().catch(() => {});
  return audio;
}

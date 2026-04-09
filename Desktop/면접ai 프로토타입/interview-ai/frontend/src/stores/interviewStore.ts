/**
 * 면접 세션 전역 상태 스토어 (Zustand)
 */
import { create } from "zustand";
import type { Question, Session } from "@/types";

interface InterviewState {
  currentSession: Session | null;
  currentQuestion: Question | null;
  questionIndex: number;
  totalQuestions: number;
  isRecording: boolean;
  isUploading: boolean;
  isFinished: boolean;
  audioBlobs: Blob[];

  setSession: (session: Session) => void;
  setCurrentQuestion: (q: Question, total?: number) => void;
  setRecording: (v: boolean) => void;
  setUploading: (v: boolean) => void;
  addAudioBlob: (blob: Blob) => void;
  finishSession: () => void;
  reset: () => void;
}

export const useInterviewStore = create<InterviewState>((set) => ({
  currentSession: null,
  currentQuestion: null,
  questionIndex: 0,
  totalQuestions: 5,
  isRecording: false,
  isUploading: false,
  isFinished: false,
  audioBlobs: [],

  setSession: (session) => set({ currentSession: session }),

  setCurrentQuestion: (q, total) =>
    set((state) => ({
      currentQuestion: q,
      questionIndex: q.question_order - 1,
      totalQuestions: total ?? state.totalQuestions,
    })),

  setRecording: (v) => set({ isRecording: v }),
  setUploading: (v) => set({ isUploading: v }),

  addAudioBlob: (blob) =>
    set((state) => ({ audioBlobs: [...state.audioBlobs, blob] })),

  finishSession: () => set({ isFinished: true }),

  reset: () =>
    set({
      currentSession: null,
      currentQuestion: null,
      questionIndex: 0,
      totalQuestions: 5,
      isRecording: false,
      isUploading: false,
      isFinished: false,
      audioBlobs: [],
    }),
}));

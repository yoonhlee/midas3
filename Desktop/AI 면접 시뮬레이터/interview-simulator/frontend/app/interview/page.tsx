"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

const API = "http://localhost:8000";

interface Question {
  id: number;
  question_text: string;
  question_type: string;
  order_num: number;
}

function InterviewContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const interviewId = searchParams.get("id");

  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [transcript, setTranscript] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [loadingQs, setLoadingQs] = useState(true);
  const [loadingNext, setLoadingNext] = useState(false);
  const [error, setError] = useState("");
  const [jobTitle, setJobTitle] = useState("");

  const recognitionRef = useRef<any>(null);
  const finalTranscriptRef = useRef("");

  // 질문 생성
  useEffect(() => {
    if (!interviewId) {
      router.push("/");
      return;
    }

    async function loadInterview() {
      try {
        // 면접 정보 먼저 조회
        const infoRes = await fetch(`${API}/api/interviews/${interviewId}`);
        if (!infoRes.ok) throw new Error("면접 정보 조회 실패");
        const info = await infoRes.json();
        setJobTitle(info.job_title);

        // 질문 생성
        const qRes = await fetch(`${API}/api/interviews/${interviewId}/questions`, {
          method: "POST",
        });
        if (!qRes.ok) throw new Error("질문 생성 실패");
        const qData = await qRes.json();
        setQuestions(qData.questions);
      } catch {
        setError("질문을 불러오는 데 실패했습니다. 다시 시도해주세요.");
      } finally {
        setLoadingQs(false);
      }
    }
    loadInterview();
  }, [interviewId, router]);

  // Web Speech API 초기화
  const initRecognition = useCallback(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return null;

    const rec = new SpeechRecognition();
    rec.lang = "ko-KR";
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (event: any) => {
      let interim = "";
      let final = finalTranscriptRef.current;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += t;
          finalTranscriptRef.current = final;
        } else {
          interim += t;
        }
      }
      setTranscript(final + interim);
    };

    rec.onerror = (e: any) => {
      if (e.error !== "aborted") {
        setError("음성 인식 오류: " + e.error);
      }
      setIsRecording(false);
    };

    rec.onend = () => {
      setIsRecording(false);
    };

    return rec;
  }, []);

  function startRecording() {
    finalTranscriptRef.current = answers[questions[currentIdx]?.id] || "";
    setTranscript(finalTranscriptRef.current);

    const rec = initRecognition();
    if (!rec) {
      setError("이 브라우저는 음성 인식을 지원하지 않습니다. Chrome을 사용해주세요.");
      return;
    }
    recognitionRef.current = rec;
    rec.start();
    setIsRecording(true);
    setError("");
  }

  function stopRecording() {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    setIsRecording(false);
    const qId = questions[currentIdx]?.id;
    if (qId) {
      setAnswers((prev) => ({ ...prev, [qId]: finalTranscriptRef.current }));
    }
  }

  async function handleNext() {
    const currentQ = questions[currentIdx];
    const answerText = answers[currentQ?.id] || transcript;

    if (!answerText.trim()) {
      setError("답변을 먼저 입력해주세요.");
      return;
    }

    setLoadingNext(true);
    setError("");

    try {
      await fetch(`${API}/api/answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question_id: currentQ.id,
          answer_text: answerText.trim(),
        }),
      });

      if (currentIdx < questions.length - 1) {
        setCurrentIdx((i) => i + 1);
        finalTranscriptRef.current = "";
        setTranscript("");
        setIsRecording(false);
      } else {
        // 마지막 질문 → 분석
        await fetch(`${API}/api/analysis/${interviewId}`, { method: "POST" });
        router.push(`/result/${interviewId}`);
      }
    } catch {
      setError("답변 저장에 실패했습니다. 다시 시도해주세요.");
    } finally {
      setLoadingNext(false);
    }
  }

  if (loadingQs) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-600 text-lg font-medium">
            AI가 면접 질문을 준비하고 있습니다...
          </p>
          <p className="text-slate-400 text-sm mt-1">잠시만 기다려주세요</p>
        </div>
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error || "질문을 불러올 수 없습니다."}</p>
          <button
            onClick={() => router.push("/")}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg"
          >
            처음으로 돌아가기
          </button>
        </div>
      </div>
    );
  }

  const currentQ = questions[currentIdx];
  const currentAnswer = answers[currentQ.id] || transcript;
  const progress = ((currentIdx + 1) / questions.length) * 100;
  const isLast = currentIdx === questions.length - 1;

  return (
    <main className="min-h-screen bg-slate-50">
      {/* 상단 바 */}
      <header className="bg-white border-b border-slate-100 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div>
            <p className="text-sm text-slate-500">{jobTitle} 면접</p>
            <p className="text-sm font-medium text-slate-700">
              {currentIdx + 1} / {questions.length} 질문
            </p>
          </div>
          <div className="text-right">
            <span className="text-xs text-slate-400 bg-slate-100 px-2 py-1 rounded-full">
              {currentQ.question_type}
            </span>
          </div>
        </div>
        {/* 진행 바 */}
        <div className="max-w-3xl mx-auto mt-3">
          <div className="w-full bg-slate-100 rounded-full h-1.5">
            <div
              className="bg-blue-600 h-1.5 rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-6 py-10">
        {/* 질문 카드 */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 mb-6">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center shrink-0">
              <span className="text-blue-700 font-bold text-sm">Q{currentIdx + 1}</span>
            </div>
            <div>
              <p className="text-slate-900 text-xl font-medium leading-relaxed">
                {currentQ.question_text}
              </p>
            </div>
          </div>
        </div>

        {/* 답변 영역 */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-slate-700">내 답변</h3>
            {currentAnswer && (
              <span className="text-xs text-slate-400">{currentAnswer.length}자</span>
            )}
          </div>

          {/* 실시간 텍스트 표시 */}
          <div className="min-h-32 bg-slate-50 rounded-xl p-4 text-slate-700 text-base leading-relaxed mb-4">
            {currentAnswer ? (
              <span>{currentAnswer}</span>
            ) : (
              <span className="text-slate-400">
                {isRecording
                  ? "말씀하세요..."
                  : "아래 버튼을 눌러 답변을 시작하세요"}
              </span>
            )}
          </div>

          {/* 직접 입력 (대안) */}
          {!isRecording && (
            <textarea
              value={currentAnswer}
              onChange={(e) => {
                const qId = currentQ.id;
                finalTranscriptRef.current = e.target.value;
                setTranscript(e.target.value);
                setAnswers((prev) => ({ ...prev, [qId]: e.target.value }));
              }}
              placeholder="또는 직접 텍스트로 입력하세요..."
              rows={3}
              className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-700 placeholder-slate-400 text-sm resize-none"
            />
          )}

          {/* 녹음 버튼 */}
          <div className="flex justify-center mt-4">
            {!isRecording ? (
              <button
                onClick={startRecording}
                className="flex items-center gap-3 bg-blue-600 hover:bg-blue-700 text-white font-medium px-8 py-3 rounded-full transition-colors"
              >
                <span className="w-3 h-3 bg-white rounded-full" />
                녹음 시작
              </button>
            ) : (
              <button
                onClick={stopRecording}
                className="flex items-center gap-3 bg-red-500 hover:bg-red-600 text-white font-medium px-8 py-3 rounded-full transition-colors animate-pulse"
              >
                <span className="w-3 h-3 bg-white rounded-full animate-ping" />
                녹음 중지
              </button>
            )}
          </div>
        </div>

        {/* 에러 */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl mb-4">
            {error}
          </div>
        )}

        {/* 다음 / 완료 버튼 */}
        <div className="flex justify-end">
          <button
            onClick={handleNext}
            disabled={loadingNext || isRecording || !currentAnswer.trim()}
            className="bg-slate-900 hover:bg-slate-700 disabled:bg-slate-300 text-white font-semibold px-8 py-3 rounded-xl transition-colors"
          >
            {loadingNext
              ? isLast
                ? "분석 중..."
                : "저장 중..."
              : isLast
              ? "면접 완료 → AI 분석"
              : "다음 질문"}
          </button>
        </div>
      </div>
    </main>
  );
}

export default function InterviewPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-50 flex items-center justify-center">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <InterviewContent />
    </Suspense>
  );
}

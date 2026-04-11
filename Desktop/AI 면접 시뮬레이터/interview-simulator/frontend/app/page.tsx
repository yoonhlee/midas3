"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const API = "http://localhost:8000";

export default function HomePage() {
  const router = useRouter();
  const [jobTitle, setJobTitle] = useState("");
  const [jdText, setJdText] = useState("");
  const [noJd, setNoJd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleStart() {
    if (!jobTitle.trim()) {
      setError("지원 직무명을 입력해주세요.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/interviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_title: jobTitle.trim(),
          jd_text: noJd ? null : jdText.trim() || null,
        }),
      });
      if (!res.ok) throw new Error("면접 생성 실패");
      const data = await res.json();
      router.push(`/interview?id=${data.id}`);
    } catch {
      setError("서버에 연결할 수 없습니다. 백엔드 서버가 실행 중인지 확인하세요.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
      {/* 헤더 */}
      <header className="flex justify-between items-center px-6 py-4 max-w-5xl mx-auto">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <span className="text-white text-sm font-bold">AI</span>
          </div>
          <span className="font-bold text-slate-800 text-lg">면접 시뮬레이터</span>
        </div>
        <Link
          href="/dashboard"
          className="text-sm text-slate-600 hover:text-blue-600 transition-colors border border-slate-200 rounded-lg px-4 py-2 hover:border-blue-300 bg-white"
        >
          대시보드 보기
        </Link>
      </header>

      <div className="max-w-2xl mx-auto px-6 py-12">
        {/* 히어로 */}
        <div className="text-center mb-10">
          <div className="inline-block bg-blue-100 text-blue-700 text-sm font-medium px-3 py-1 rounded-full mb-4">
            AI 기반 면접 연습
          </div>
          <h1 className="text-4xl font-bold text-slate-900 mb-4 leading-tight">
            실전처럼 연습하고<br />
            <span className="text-blue-600">AI 피드백</span>으로 성장하세요
          </h1>
          <p className="text-slate-500 text-lg">
            음성으로 답변하면 AI가 논리성, 구체성, 직무적합성을 분석합니다
          </p>
        </div>

        {/* 입력 폼 */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
          <div className="space-y-6">
            {/* 직무명 */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">
                지원 직무명 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleStart()}
                placeholder="예: 백엔드 개발자, 데이터 분석가, 마케터"
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-slate-800 placeholder-slate-400"
              />
            </div>

            {/* 채용공고 */}
            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="text-sm font-semibold text-slate-700">
                  채용공고{" "}
                  <span className="text-slate-400 font-normal">(선택)</span>
                </label>
              </div>
              <textarea
                value={jdText}
                onChange={(e) => setJdText(e.target.value)}
                disabled={noJd}
                rows={5}
                placeholder={`채용공고 전문 또는 자격요건/우대사항을 붙여넣으세요.\n키워드만 입력해도 괜찮아요 (예: SQL, Python, 통계분석)`}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-slate-800 placeholder-slate-400 resize-none disabled:bg-slate-50 disabled:text-slate-400"
              />
              <label className="flex items-center gap-2 mt-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={noJd}
                  onChange={(e) => {
                    setNoJd(e.target.checked);
                    if (e.target.checked) setJdText("");
                  }}
                  className="w-4 h-4 rounded text-blue-600 border-slate-300 focus:ring-blue-500"
                />
                <span className="text-sm text-slate-600">
                  채용공고 없이 일반 면접으로 진행
                </span>
              </label>
            </div>

            {/* 에러 */}
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">
                {error}
              </div>
            )}

            {/* 시작 버튼 */}
            <button
              onClick={handleStart}
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-semibold py-4 rounded-xl transition-colors text-base"
            >
              {loading ? "준비 중..." : "면접 시작하기"}
            </button>
          </div>
        </div>

        {/* 특징 */}
        <div className="grid grid-cols-3 gap-4 mt-6">
          {[
            { icon: "🎤", title: "음성 인식", desc: "브라우저 내장 STT로 실시간 변환" },
            { icon: "🤖", title: "AI 분석", desc: "Claude AI가 5개 항목 종합 평가" },
            { icon: "📊", title: "성장 추이", desc: "회차별 점수 변화 대시보드" },
          ].map((f) => (
            <div
              key={f.title}
              className="bg-white rounded-xl p-4 text-center border border-slate-100"
            >
              <div className="text-2xl mb-2">{f.icon}</div>
              <div className="text-sm font-semibold text-slate-700">{f.title}</div>
              <div className="text-xs text-slate-500 mt-1">{f.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

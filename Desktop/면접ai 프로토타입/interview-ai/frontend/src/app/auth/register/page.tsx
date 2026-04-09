"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/authStore";
import { Mic } from "lucide-react";

const JOB_CATEGORIES = ["데이터분석", "개발", "기획", "마케팅", "영업", "인사", "운영"];

export default function RegisterPage() {
  const router = useRouter();
  const { register } = useAuthStore();
  const [form, setForm] = useState({ name: "", email: "", password: "", target_job_category: "" });
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (form.password.length < 8) { setError("비밀번호는 8자 이상이어야 합니다."); return; }
    setIsLoading(true);
    try {
      await register({
        name: form.name,
        email: form.email,
        password: form.password,
        target_job_category: form.target_job_category || undefined,
      });
      router.push("/dashboard");
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(msg || "회원가입 중 오류가 발생했습니다.");
    } finally {
      setIsLoading(false);
    }
  };

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value })),
  });

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 text-white mb-4">
            <Mic className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">회원가입</h1>
          <p className="text-slate-500 mt-1">AI 모의면접을 시작하세요</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 space-y-5">
          {error && <div className="px-4 py-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">이름</label>
            <input type="text" required {...field("name")}
              className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              placeholder="홍길동" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">이메일</label>
            <input type="email" required {...field("email")}
              className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              placeholder="you@example.com" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">비밀번호</label>
            <input type="password" required {...field("password")}
              className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              placeholder="8자 이상" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">지원 직무 (선택)</label>
            <select {...field("target_job_category")}
              className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm bg-white">
              <option value="">선택 안 함</option>
              {JOB_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <button type="submit" disabled={isLoading}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium transition text-sm">
            {isLoading ? "가입 중..." : "회원가입"}
          </button>

          <p className="text-center text-sm text-slate-500">
            이미 계정이 있으신가요?{" "}
            <Link href="/auth/login" className="text-blue-600 hover:underline font-medium">로그인</Link>
          </p>
        </form>
      </div>
    </div>
  );
}

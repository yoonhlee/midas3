"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/authStore";
import { Mic } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuthStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      await login(email, password);
      router.push("/dashboard");
    } catch {
      setError("이메일 또는 비밀번호가 올바르지 않습니다.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 text-white mb-4">
            <Mic className="w-7 h-7" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">로그인</h1>
          <p className="text-slate-500 mt-1">InterviewAI에 오신 것을 환영합니다</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 space-y-5">
          {error && (
            <div className="px-4 py-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>
          )}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">이메일</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">비밀번호</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium transition text-sm"
          >
            {isLoading ? "로그인 중..." : "로그인"}
          </button>

          <p className="text-center text-sm text-slate-500">
            계정이 없으신가요?{" "}
            <Link href="/auth/register" className="text-blue-600 hover:underline font-medium">
              회원가입
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}

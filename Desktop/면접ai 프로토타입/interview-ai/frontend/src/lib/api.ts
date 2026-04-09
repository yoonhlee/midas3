/**
 * API 클라이언트 — axios 기반, JWT 자동 주입 + 토큰 갱신
 */
import axios, { AxiosInstance, InternalAxiosRequestConfig } from "axios";
import type {
  AnswerUploadResponse,
  DashboardMetrics,
  DashboardSummary,
  DashboardTrends,
  Question,
  Session,
  SessionListItem,
  SessionResult,
  TimeseriesPoint,
  TokenResponse,
  User,
} from "@/types";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const api: AxiosInstance = axios.create({
  baseURL: `${BASE_URL}/api/v1`,
  headers: { "Content-Type": "application/json" },
  timeout: 30000,
});

// Request interceptor — Bearer 토큰 주입
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("access_token");
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

// Response interceptor — 401 시 토큰 갱신
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        const refresh = localStorage.getItem("refresh_token");
        if (!refresh) throw new Error("no refresh token");
        const { data } = await axios.post(`${BASE_URL}/api/v1/auth/refresh`, {
          refresh_token: refresh,
        });
        localStorage.setItem("access_token", data.access_token);
        localStorage.setItem("refresh_token", data.refresh_token);
        originalRequest.headers.Authorization = `Bearer ${data.access_token}`;
        return api(originalRequest);
      } catch {
        localStorage.removeItem("access_token");
        localStorage.removeItem("refresh_token");
        if (typeof window !== "undefined") window.location.href = "/auth/login";
      }
    }
    return Promise.reject(error);
  }
);

// =============================================
// 인증 API
// =============================================
export const authApi = {
  register: (data: { email: string; password: string; name: string; target_job_category?: string }) =>
    api.post<TokenResponse>("/auth/register", data).then((r) => r.data),

  login: (email: string, password: string) =>
    api.post<TokenResponse>("/auth/login", { email, password }).then((r) => r.data),

  getMe: () => api.get<User>("/auth/me").then((r) => r.data),

  updateMe: (data: { name?: string; target_job_category?: string; target_job_keywords?: string[] }) =>
    api.patch<User>("/auth/me", data).then((r) => r.data),
};

// =============================================
// 면접 세션 API
// =============================================
export const interviewApi = {
  createSession: (job_category?: string) =>
    api.post<Session>("/interviews", { job_category }).then((r) => r.data),

  listSessions: (page = 1) =>
    api.get<SessionListItem[]>("/interviews", { params: { page } }).then((r) => r.data),

  getSession: (sessionId: string) =>
    api.get<Session>(`/interviews/${sessionId}`).then((r) => r.data),

  startInterview: (sessionId: string) =>
    api.post<Question>(`/interviews/${sessionId}/start`).then((r) => r.data),

  getNextQuestion: (sessionId: string) =>
    api.get<Question | null>(`/interviews/${sessionId}/next-question`).then((r) => r.data),

  uploadAnswer: (
    sessionId: string,
    questionOrder: number,
    audioBlob: Blob,
    audioDurationSec?: number
  ) => {
    const form = new FormData();
    form.append("audio_file", audioBlob, `q${questionOrder}_answer.webm`);
    form.append("question_order", String(questionOrder));
    if (audioDurationSec != null) form.append("audio_duration_sec", String(audioDurationSec));
    return api
      .post<AnswerUploadResponse>(`/interviews/${sessionId}/answers`, form, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data);
  },

  finishInterview: (sessionId: string) =>
    api.post(`/interviews/${sessionId}/finish`).then((r) => r.data),

  getStatus: (sessionId: string) =>
    api.get(`/interviews/${sessionId}/status`).then((r) => r.data),

  // 결과
  getResult: (sessionId: string) =>
    api.get<SessionResult>(`/interviews/${sessionId}/result`).then((r) => r.data),

  getTimeseries: (sessionId: string) =>
    api
      .get<{ session_id: string; data: TimeseriesPoint[] }>(`/interviews/${sessionId}/result/timeseries`)
      .then((r) => r.data),
};

// =============================================
// 대시보드 API
// =============================================
export const dashboardApi = {
  getSummary: () => api.get<DashboardSummary>("/dashboard/summary").then((r) => r.data),
  getTrends: () => api.get<DashboardTrends>("/dashboard/trends").then((r) => r.data),
  getMetrics: () => api.get<DashboardMetrics>("/dashboard/metrics").then((r) => r.data),
};

export default api;

// =============================================
// 공통 타입 정의
// =============================================

export interface User {
  id: string;
  email: string;
  name: string;
  target_job_category?: string;
  target_job_keywords?: string[];
  created_at: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  user: User;
}

// =============================================
// 면접 세션
// =============================================

export interface Session {
  id: string;
  session_number: number;
  job_category?: string;
  status: "in_progress" | "analyzing" | "completed" | "failed";
  total_score?: number;
  started_at: string;
  completed_at?: string;
  analysis_completed_at?: string;
}

export interface SessionListItem extends Session {
  answer_count: number;
}

export interface Question {
  question_id: string;
  question_text: string;
  question_order: number;
  category: string;
  expected_star_applicable: boolean;
  tts_url?: string;
}

export interface AnswerUploadResponse {
  answer_id: string;
  message: string;
  next_question?: Question;
  is_last_question: boolean;
}

// =============================================
// 분석 결과
// =============================================

export interface ScoreDetail {
  score?: number;
  feedback?: string;
}

export interface AudioAnalysis {
  duration_sec?: number;
  speech_rate_wps?: number;
  pause_count?: number;
  pause_ratio?: number;
  pitch_mean?: number;
  pitch_std?: number;
  rms_mean?: number;
  rms_std?: number;
  filler_total?: number;
  filler_ratio?: number;
  end_of_sentence_rms_drop?: number;
  confident_ending_ratio?: number;
  uncertain_ending_ratio?: number;
}

export interface AnswerResult {
  answer_id: string;
  question_order: number;
  question_text?: string;
  transcript?: string;
  highlighted_transcript?: string;
  scores: {
    logic?: ScoreDetail;
    specificity?: ScoreDetail;
    job_relevance?: ScoreDetail;
    structure?: ScoreDetail;
    delivery?: ScoreDetail;
  };
  weighted_total?: number;
  audio_analysis?: AudioAnalysis;
  filler_details?: FillerDetail[];
  repetition_details?: RepetitionDetail[];
  self_correction_count?: number;
  star_result?: StarResult;
  improvement_suggestions?: string[];
}

export interface SessionResult {
  session_id: string;
  session_number: number;
  job_category?: string;
  total_score?: number;
  grade?: string;
  category_scores: {
    logic?: number;
    specificity?: number;
    job_relevance?: number;
    structure?: number;
    delivery?: number;
  };
  overall_feedback?: string;
  strength_points?: string[];
  improvement_suggestions?: string[];
  timeseries_insight?: string;
  answers: AnswerResult[];
}

export interface FillerDetail {
  word: string;
  count: number;
  positions: number[];
}

export interface RepetitionDetail {
  type: string;
  text: string;
  count: number;
  positions: number[];
}

export interface StarResult {
  has_situation: boolean;
  has_task: boolean;
  has_action: boolean;
  has_result: boolean;
  order_appropriate: boolean;
  causal_connection: number;
  overall_star_score: number;
}

export interface TimeseriesPoint {
  time_sec: number;
  pitch: number;
  rms: number;
  tension_index: number;
  answer_order?: number;
}

// =============================================
// 대시보드
// =============================================

export interface DashboardSummary {
  total_sessions: number;
  avg_score?: number;
  best_score?: number;
  latest_score?: number;
  score_trend: "improving" | "declining" | "stable";
}

export interface TrendPoint {
  session_number: number;
  date: string;
  total_score?: number;
  logic_score?: number;
  specificity_score?: number;
  job_relevance_score?: number;
  structure_score?: number;
  delivery_score?: number;
}

export interface MetricTrendPoint {
  session_number: number;
  speech_rate_wps?: number;
  pause_ratio?: number;
  filler_ratio?: number;
  repetition_score?: number;
  confident_ending_ratio?: number;
}

"""분석 결과 관련 Pydantic 스키마."""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class AudioAnalysis(BaseModel):
    duration_sec: Optional[float] = None
    speech_rate_wps: Optional[float] = None
    pause_count: Optional[int] = None
    pause_ratio: Optional[float] = None
    pitch_mean: Optional[float] = None
    pitch_std: Optional[float] = None
    rms_mean: Optional[float] = None
    rms_std: Optional[float] = None
    filler_total: Optional[int] = None
    filler_ratio: Optional[float] = None
    end_of_sentence_rms_drop: Optional[float] = None
    confident_ending_ratio: Optional[float] = None
    uncertain_ending_ratio: Optional[float] = None


class ScoreDetail(BaseModel):
    score: Optional[float] = None
    feedback: Optional[str] = None


class AnswerResultResponse(BaseModel):
    answer_id: str
    question_order: int
    question_text: Optional[str] = None
    transcript: Optional[str] = None
    highlighted_transcript: Optional[str] = None
    scores: Dict[str, ScoreDetail] = {}
    weighted_total: Optional[float] = None
    audio_analysis: Optional[AudioAnalysis] = None
    filler_details: Optional[List[Dict[str, Any]]] = None
    repetition_details: Optional[List[Dict[str, Any]]] = None
    self_correction_count: Optional[int] = None
    star_result: Optional[Dict[str, Any]] = None
    improvement_suggestions: Optional[List[str]] = None


class SessionResultResponse(BaseModel):
    session_id: str
    session_number: int
    job_category: Optional[str] = None
    total_score: Optional[float] = None
    grade: Optional[str] = None
    category_scores: Dict[str, Optional[float]] = {}
    overall_feedback: Optional[str] = None
    strength_points: Optional[List[str]] = None
    improvement_suggestions: Optional[List[str]] = None
    timeseries_insight: Optional[str] = None
    answers: List[AnswerResultResponse] = []


class TimeseriesResponse(BaseModel):
    session_id: str
    data: List[Dict[str, Any]] = []

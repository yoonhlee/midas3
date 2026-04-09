"""대시보드 관련 Pydantic 스키마."""
from typing import Dict, List, Optional
from pydantic import BaseModel


class DashboardSummary(BaseModel):
    total_sessions: int
    avg_score: Optional[float]
    best_score: Optional[float]
    latest_score: Optional[float]
    score_trend: str  # "improving" | "declining" | "stable"


class TrendPoint(BaseModel):
    session_number: int
    date: str
    total_score: Optional[float]
    logic_score: Optional[float]
    specificity_score: Optional[float]
    job_relevance_score: Optional[float]
    structure_score: Optional[float]
    delivery_score: Optional[float]


class MetricTrendPoint(BaseModel):
    session_number: int
    speech_rate_wps: Optional[float]
    pause_ratio: Optional[float]
    filler_ratio: Optional[float]
    repetition_score: Optional[float]
    confident_ending_ratio: Optional[float]


class DashboardTrends(BaseModel):
    score_trends: List[TrendPoint]


class DashboardMetrics(BaseModel):
    metric_trends: List[MetricTrendPoint]

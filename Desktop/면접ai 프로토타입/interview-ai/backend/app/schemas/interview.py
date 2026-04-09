"""면접 세션 관련 Pydantic 스키마."""
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class SessionCreate(BaseModel):
    job_category: Optional[str] = None


class QuestionResponse(BaseModel):
    question_id: str
    question_text: str
    question_order: int
    category: str
    expected_star_applicable: bool
    tts_url: Optional[str] = None


class AnswerUploadResponse(BaseModel):
    answer_id: str
    message: str
    next_question: Optional[QuestionResponse] = None
    is_last_question: bool


class SessionStatusResponse(BaseModel):
    session_id: str
    status: str
    progress_percent: Optional[float] = None
    current_phase: Optional[str] = None


class SessionListItem(BaseModel):
    id: str
    session_number: int
    job_category: Optional[str]
    status: str
    total_score: Optional[float]
    started_at: datetime
    completed_at: Optional[datetime]
    answer_count: int

    model_config = {"from_attributes": True}


class SessionDetailResponse(BaseModel):
    id: str
    session_number: int
    job_category: Optional[str]
    status: str
    total_score: Optional[float]
    started_at: datetime
    completed_at: Optional[datetime]
    analysis_completed_at: Optional[datetime]

    model_config = {"from_attributes": True}

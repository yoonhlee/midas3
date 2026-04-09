"""답변 모델 — SQLite/PostgreSQL 호환."""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Index, Integer, JSON, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Answer(Base):
    __tablename__ = "answers"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("interview_sessions.id", ondelete="CASCADE"), nullable=False
    )
    question_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("questions.id")
    )
    question_order: Mapped[int] = mapped_column(Integer, nullable=False)
    audio_file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    audio_duration_sec: Mapped[Optional[float]] = mapped_column(Numeric(8, 2))
    transcript: Mapped[Optional[str]] = mapped_column(Text)
    transcript_segments: Mapped[Optional[dict]] = mapped_column(JSON)
    vad_segments: Mapped[Optional[dict]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20), default="recorded")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    session: Mapped["InterviewSession"] = relationship(  # noqa: F821
        "InterviewSession", back_populates="answers"
    )
    question: Mapped[Optional["Question"]] = relationship(  # noqa: F821
        "Question", back_populates="answers"
    )
    analysis_result: Mapped[Optional["AnalysisResult"]] = relationship(  # noqa: F821
        "AnalysisResult", back_populates="answer", uselist=False
    )

    __table_args__ = (
        Index("idx_answers_session", "session_id", "question_order"),
    )

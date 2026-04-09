"""점수 모델 — SQLite/PostgreSQL 호환."""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Index, JSON, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Score(Base):
    __tablename__ = "scores"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    session_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("interview_sessions.id", ondelete="CASCADE"), nullable=False
    )
    answer_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("answers.id")
    )

    logic_score: Mapped[Optional[float]] = mapped_column(Numeric(5, 2))
    specificity_score: Mapped[Optional[float]] = mapped_column(Numeric(5, 2))
    job_relevance_score: Mapped[Optional[float]] = mapped_column(Numeric(5, 2))
    structure_score: Mapped[Optional[float]] = mapped_column(Numeric(5, 2))
    delivery_score: Mapped[Optional[float]] = mapped_column(Numeric(5, 2))
    weighted_total: Mapped[Optional[float]] = mapped_column(Numeric(5, 2))

    logic_feedback: Mapped[Optional[str]] = mapped_column(Text)
    specificity_feedback: Mapped[Optional[str]] = mapped_column(Text)
    job_relevance_feedback: Mapped[Optional[str]] = mapped_column(Text)
    structure_feedback: Mapped[Optional[str]] = mapped_column(Text)
    delivery_feedback: Mapped[Optional[str]] = mapped_column(Text)

    overall_feedback: Mapped[Optional[str]] = mapped_column(Text)
    improvement_suggestions: Mapped[Optional[list]] = mapped_column(JSON)  # list[str]

    score_type: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    session: Mapped["InterviewSession"] = relationship(  # noqa: F821
        "InterviewSession", back_populates="scores"
    )
    answer: Mapped[Optional["Answer"]] = relationship(  # noqa: F821
        "Answer", foreign_keys=[answer_id]
    )

    __table_args__ = (
        Index("idx_scores_session", "session_id"),
    )

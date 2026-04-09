"""면접 세션 모델 — SQLite/PostgreSQL 호환."""
import uuid
from datetime import datetime
from typing import List, Optional

from sqlalchemy import DateTime, ForeignKey, Index, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class InterviewSession(Base):
    __tablename__ = "interview_sessions"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    session_number: Mapped[int] = mapped_column(Integer, nullable=False)
    job_category: Mapped[Optional[str]] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(20), default="in_progress")
    total_score: Mapped[Optional[float]] = mapped_column(Numeric(5, 2))
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    analysis_completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    user: Mapped["User"] = relationship("User", back_populates="sessions")  # noqa: F821
    answers: Mapped[List["Answer"]] = relationship(  # noqa: F821
        "Answer", back_populates="session", cascade="all, delete-orphan",
        order_by="Answer.question_order"
    )
    scores: Mapped[List["Score"]] = relationship(  # noqa: F821
        "Score", back_populates="session", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("idx_sessions_user", "user_id", "created_at"),
    )

"""면접 질문 모델 — SQLite/PostgreSQL 호환."""
import uuid
from datetime import datetime
from typing import List, Optional

from sqlalchemy import Boolean, DateTime, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Question(Base):
    __tablename__ = "questions"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    category: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    subcategory: Mapped[Optional[str]] = mapped_column(String(100))
    question_text: Mapped[str] = mapped_column(Text, nullable=False)
    expected_star_applicable: Mapped[bool] = mapped_column(Boolean, default=False)
    difficulty_level: Mapped[int] = mapped_column(Integer, default=1)
    job_categories: Mapped[Optional[List]] = mapped_column(JSON)  # list[str]
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    answers: Mapped[List["Answer"]] = relationship("Answer", back_populates="question")  # noqa: F821

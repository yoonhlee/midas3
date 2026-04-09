"""사용자 모델 — SQLite/PostgreSQL 호환."""
import uuid
from datetime import datetime
from typing import List, Optional

from sqlalchemy import Boolean, DateTime, JSON, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    target_job_category: Mapped[Optional[str]] = mapped_column(String(100))
    target_job_keywords: Mapped[Optional[List]] = mapped_column(JSON)  # list[str]
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    sessions: Mapped[List["InterviewSession"]] = relationship(  # noqa: F821
        "InterviewSession", back_populates="user", cascade="all, delete-orphan"
    )

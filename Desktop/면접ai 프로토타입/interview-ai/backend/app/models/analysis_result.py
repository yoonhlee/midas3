"""분석 결과 모델 — SQLite/PostgreSQL 호환."""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class AnalysisResult(Base):
    __tablename__ = "analysis_results"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    answer_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("answers.id", ondelete="CASCADE"), nullable=False, unique=True
    )

    word_count: Mapped[Optional[int]] = mapped_column(Integer)
    sentence_count: Mapped[Optional[int]] = mapped_column(Integer)
    filler_words: Mapped[Optional[dict]] = mapped_column(JSON)
    repetition_score: Mapped[Optional[float]] = mapped_column(Numeric(5, 2))
    repetition_details: Mapped[Optional[dict]] = mapped_column(JSON)
    self_correction_count: Mapped[Optional[int]] = mapped_column(Integer)
    self_correction_details: Mapped[Optional[dict]] = mapped_column(JSON)

    speech_duration_sec: Mapped[Optional[float]] = mapped_column(Numeric(8, 2))
    speech_rate_wpm: Mapped[Optional[float]] = mapped_column(Numeric(6, 2))
    pause_count: Mapped[Optional[int]] = mapped_column(Integer)
    pause_ratio: Mapped[Optional[float]] = mapped_column(Numeric(5, 4))
    pitch_mean: Mapped[Optional[float]] = mapped_column(Numeric(8, 2))
    pitch_std: Mapped[Optional[float]] = mapped_column(Numeric(8, 2))
    rms_mean: Mapped[Optional[float]] = mapped_column(Numeric(10, 6))
    rms_std: Mapped[Optional[float]] = mapped_column(Numeric(10, 6))
    end_of_sentence_rms_drop: Mapped[Optional[float]] = mapped_column(Numeric(5, 4))

    confident_ending_ratio: Mapped[Optional[float]] = mapped_column(Numeric(5, 4))
    uncertain_ending_ratio: Mapped[Optional[float]] = mapped_column(Numeric(5, 4))
    ending_details: Mapped[Optional[dict]] = mapped_column(JSON)

    star_score: Mapped[Optional[dict]] = mapped_column(JSON)
    timeseries_data: Mapped[Optional[dict]] = mapped_column(JSON)
    raw_audio_features: Mapped[Optional[dict]] = mapped_column(JSON)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    answer: Mapped["Answer"] = relationship("Answer", back_populates="analysis_result")  # noqa: F821

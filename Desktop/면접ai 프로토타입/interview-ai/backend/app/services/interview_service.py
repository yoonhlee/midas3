"""면접 세션 비즈니스 로직 서비스."""
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Tuple

import aiofiles
import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.answer import Answer
from app.models.interview_session import InterviewSession
from app.models.question import Question
from app.services.question_service import question_service

logger = structlog.get_logger(__name__)


class InterviewService:
    async def create_session(self, db: AsyncSession, user_id: str, job_category: Optional[str] = None) -> InterviewSession:
        count_result = await db.execute(
            select(func.count()).where(InterviewSession.user_id == user_id)
        )
        session_number = (count_result.scalar() or 0) + 1
        session = InterviewSession(
            user_id=user_id,
            session_number=session_number,
            job_category=job_category,
            status="in_progress",
        )
        db.add(session)
        await db.flush()
        await db.refresh(session)
        return session

    async def start_session(self, db: AsyncSession, session: InterviewSession) -> Tuple[Question, int]:
        existing = await db.execute(
            select(Answer)
            .where(Answer.session_id == session.id)
            .order_by(Answer.question_order)
            .limit(1)
        )
        first = existing.scalar_one_or_none()
        if first and first.question_id:
            q = await db.execute(select(Question).where(Question.id == first.question_id))
            return q.scalar_one(), 1

        questions = await question_service.get_questions_for_session(db, job_category=session.job_category)
        for idx, q in enumerate(questions, start=1):
            placeholder = Answer(
                session_id=session.id,
                question_id=q.id,
                question_order=idx,
                audio_file_path="",
                status="pending",
            )
            db.add(placeholder)
        await db.flush()
        return questions[0], 1

    async def get_next_question(self, db: AsyncSession, session: InterviewSession) -> Optional[Tuple[Question, int]]:
        result = await db.execute(
            select(Answer)
            .where(Answer.session_id == session.id, Answer.status == "pending")
            .order_by(Answer.question_order)
            .limit(1)
        )
        answer = result.scalar_one_or_none()
        if not answer or not answer.question_id:
            return None
        q = await db.execute(select(Question).where(Question.id == answer.question_id))
        q_obj = q.scalar_one_or_none()
        return (q_obj, answer.question_order) if q_obj else None

    async def save_audio(self, session_id: str, user_id: str, question_order: int, audio_bytes: bytes, filename: str) -> str:
        ext = Path(filename).suffix or ".webm"
        dir_path = Path(settings.STORAGE_PATH) / "audio" / user_id / session_id
        os.makedirs(dir_path, exist_ok=True)
        file_path = dir_path / f"q{question_order}_raw{ext}"
        async with aiofiles.open(file_path, "wb") as f:
            await f.write(audio_bytes)
        return str(file_path)

    async def record_answer(self, db: AsyncSession, session: InterviewSession, question_order: int, audio_file_path: str, audio_duration_sec: Optional[float] = None) -> Answer:
        result = await db.execute(
            select(Answer).where(Answer.session_id == session.id, Answer.question_order == question_order)
        )
        answer = result.scalar_one_or_none()
        if answer:
            answer.audio_file_path = audio_file_path
            answer.audio_duration_sec = audio_duration_sec
            answer.status = "recorded"
        else:
            answer = Answer(
                session_id=session.id,
                question_order=question_order,
                audio_file_path=audio_file_path,
                audio_duration_sec=audio_duration_sec,
                status="recorded",
            )
            db.add(answer)
        await db.flush()
        await db.refresh(answer)
        return answer

    async def finish_session(self, db: AsyncSession, session: InterviewSession) -> InterviewSession:
        session.status = "analyzing"
        session.completed_at = datetime.now(timezone.utc)
        await db.flush()
        await db.refresh(session)
        return session

    async def get_session(self, db: AsyncSession, session_id: str, user_id: str) -> Optional[InterviewSession]:
        result = await db.execute(
            select(InterviewSession).where(InterviewSession.id == session_id, InterviewSession.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def list_sessions(self, db: AsyncSession, user_id: str, page: int = 1, page_size: int = 20) -> List[InterviewSession]:
        offset = (page - 1) * page_size
        result = await db.execute(
            select(InterviewSession)
            .where(InterviewSession.user_id == user_id)
            .order_by(InterviewSession.created_at.desc())
            .offset(offset).limit(page_size)
        )
        return list(result.scalars().all())


interview_service = InterviewService()

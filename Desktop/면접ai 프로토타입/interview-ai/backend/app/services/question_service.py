"""면접 질문 선택 및 관리 서비스."""
import random
import uuid
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.question import Question


class QuestionService:
    async def get_questions_for_session(
        self,
        db: AsyncSession,
        job_category: Optional[str] = None,
        count: int = None,
    ) -> List[Question]:
        """세션에 사용할 질문 목록을 카테고리별 균형 있게 선택."""
        if count is None:
            count = settings.MAX_INTERVIEW_QUESTIONS

        # 카테고리 비율: 경험 2, 역량 1, 상황 1, 인성 1
        category_quotas = {
            "경험": 2,
            "역량": 1,
            "상황": 1,
            "인성": 1,
        }

        questions: List[Question] = []
        for category, quota in category_quotas.items():
            stmt = select(Question).where(
                Question.category == category,
                Question.is_active == True,  # noqa: E712
            )
            if job_category:
                stmt = stmt.where(
                    Question.job_categories.any(job_category)
                )
            result = await db.execute(stmt)
            pool = result.scalars().all()
            selected = random.sample(pool, min(quota, len(pool)))
            questions.extend(selected)

        # 모자라면 직무지식 질문으로 채우기
        remaining = count - len(questions)
        if remaining > 0:
            stmt = select(Question).where(
                Question.is_active == True,  # noqa: E712
                Question.id.notin_([q.id for q in questions]),
            )
            result = await db.execute(stmt)
            pool = result.scalars().all()
            extra = random.sample(pool, min(remaining, len(pool)))
            questions.extend(extra)

        random.shuffle(questions)
        return questions[:count]

    async def get_by_id(self, db: AsyncSession, question_id: uuid.UUID) -> Optional[Question]:
        result = await db.execute(select(Question).where(Question.id == question_id))
        return result.scalar_one_or_none()


question_service = QuestionService()

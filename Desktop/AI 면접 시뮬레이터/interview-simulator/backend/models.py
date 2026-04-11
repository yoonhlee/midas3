from pydantic import BaseModel
from typing import Optional


class InterviewCreate(BaseModel):
    job_title: str
    jd_text: Optional[str] = None


class AnswerCreate(BaseModel):
    question_id: int
    answer_text: str

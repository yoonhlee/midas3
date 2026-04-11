import json
import os
from fastapi import APIRouter, HTTPException
from database import get_db
from models import InterviewCreate

router = APIRouter()

USE_MOCK = not bool(os.getenv("ANTHROPIC_API_KEY", "").strip())

MOCK_QUESTIONS_NO_JD = [
    {"order": 1, "type": "경험형", "question": "지금까지 경험 중 가장 어려웠던 문제를 어떻게 해결했는지 말씀해 주세요."},
    {"order": 2, "type": "경험형", "question": "팀 프로젝트에서 갈등이 생겼을 때 어떻게 대처하셨나요?"},
    {"order": 3, "type": "가치관형", "question": "본인이 생각하는 이상적인 팀워크란 무엇인가요?"},
    {"order": 4, "type": "가치관형", "question": "5년 후 본인의 모습을 어떻게 그리고 있나요?"},
    {"order": 5, "type": "상황형", "question": "마감이 촉박한 상황에서 예상치 못한 문제가 발생한다면 어떻게 하시겠습니까?"},
]

MOCK_QUESTIONS_WITH_JD = [
    {"order": 1, "type": "자격요건", "question": "채용공고에 언급된 핵심 기술 스택을 활용한 프로젝트 경험을 말씀해 주세요."},
    {"order": 2, "type": "자격요건", "question": "해당 직무에서 요구하는 역량을 어떻게 쌓아오셨나요?"},
    {"order": 3, "type": "우대사항", "question": "우대 사항에 해당하는 경험이 있으시다면 구체적으로 말씀해 주세요."},
    {"order": 4, "type": "우대사항", "question": "관련 도구나 기술을 실무에서 활용한 사례가 있으신가요?"},
    {"order": 5, "type": "가치관", "question": "이 직무를 선택한 동기와 앞으로의 성장 방향을 말씀해 주세요."},
]


@router.post("/interviews")
def create_interview(body: InterviewCreate):
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO interviews (job_title, jd_text, status) VALUES (?, ?, 'created')",
            (body.job_title, body.jd_text),
        )
        interview_id = cur.lastrowid
    return {"id": interview_id, "job_title": body.job_title}


@router.get("/interviews/{interview_id}")
def get_interview(interview_id: int):
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM interviews WHERE id = ?", (interview_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="면접을 찾을 수 없습니다.")
        questions = conn.execute(
            "SELECT * FROM questions WHERE interview_id = ? ORDER BY order_num",
            (interview_id,),
        ).fetchall()
    return {
        **dict(row),
        "questions": [dict(q) for q in questions],
    }


@router.post("/interviews/{interview_id}/questions")
async def generate_questions(interview_id: int):
    with get_db() as conn:
        interview = conn.execute(
            "SELECT * FROM interviews WHERE id = ?", (interview_id,)
        ).fetchone()
        if not interview:
            raise HTTPException(status_code=404, detail="면접을 찾을 수 없습니다.")

    interview = dict(interview)
    job_title = interview["job_title"]
    jd_text = interview.get("jd_text") or ""

    if USE_MOCK:
        questions = MOCK_QUESTIONS_WITH_JD if jd_text.strip() else MOCK_QUESTIONS_NO_JD
    else:
        import anthropic
        client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

        if jd_text.strip():
            system_msg = "당신은 한국어 면접 전문가입니다. 주어진 채용공고를 분석하여 맞춤형 면접 질문을 생성합니다. 반드시 JSON 형식으로만 응답하세요."
            user_msg = f"""직무명: {job_title}
채용공고: {jd_text}

위 채용공고를 분석하여 면접 질문 5개를 생성하세요.
입력 형식에 관계없이 자격요건과 우대사항을 스스로 파악하여
아래 기준으로 질문을 구성하세요.
- 자격요건에서 검증 가능한 질문 2개
- 우대사항에서 검증 가능한 질문 2개
- 직무 가치관/태도를 확인하는 질문 1개
각 질문은 실제 면접에서 사용되는 자연스러운 한국어로 작성하세요.

{{
  "questions": [
    {{"order": 1, "type": "자격요건", "question": "..."}},
    {{"order": 2, "type": "자격요건", "question": "..."}},
    {{"order": 3, "type": "우대사항", "question": "..."}},
    {{"order": 4, "type": "우대사항", "question": "..."}},
    {{"order": 5, "type": "가치관", "question": "..."}}
  ]
}}"""
        else:
            system_msg = "당신은 한국어 면접 전문가입니다. 주어진 직무에 맞는 면접 질문을 생성합니다. 반드시 JSON 형식으로만 응답하세요."
            user_msg = f"""직무명: {job_title}

위 직무의 일반적인 면접 질문 5개를 생성하세요.
경험형 2개, 가치관형 2개, 상황형 1개로 구성하세요.
각 질문은 실제 면접에서 사용되는 자연스러운 한국어로 작성하세요.

{{
  "questions": [
    {{"order": 1, "type": "경험형", "question": "..."}},
    {{"order": 2, "type": "경험형", "question": "..."}},
    {{"order": 3, "type": "가치관형", "question": "..."}},
    {{"order": 4, "type": "가치관형", "question": "..."}},
    {{"order": 5, "type": "상황형", "question": "..."}}
  ]
}}"""

        response = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=1024,
            system=system_msg,
            messages=[{"role": "user", "content": user_msg}],
        )
        raw = response.content[0].text.strip()
        data = json.loads(raw)
        questions = data["questions"]

    with get_db() as conn:
        conn.execute(
            "DELETE FROM questions WHERE interview_id = ?", (interview_id,)
        )
        for q in questions:
            conn.execute(
                "INSERT INTO questions (interview_id, question_text, question_type, order_num) VALUES (?, ?, ?, ?)",
                (interview_id, q["question"], q["type"], q["order"]),
            )
        conn.execute(
            "UPDATE interviews SET status = 'in_progress' WHERE id = ?",
            (interview_id,),
        )

    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM questions WHERE interview_id = ? ORDER BY order_num",
            (interview_id,),
        ).fetchall()

    return {"questions": [dict(r) for r in rows]}

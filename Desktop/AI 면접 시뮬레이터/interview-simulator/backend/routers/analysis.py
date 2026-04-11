import json
import os
from fastapi import APIRouter, HTTPException
from database import get_db
from models import AnswerCreate

router = APIRouter()

USE_MOCK = not bool(os.getenv("ANTHROPIC_API_KEY", "").strip())

MOCK_FEEDBACK = {
    "logic": {
        "score": 72,
        "sentence_level": "각 문장은 문법적으로 올바르고 의미가 명확합니다.",
        "context_level": "문장 간 연결이 대체로 자연스러우나 일부 주제 전환이 다소 급작스럽습니다.",
        "reason": "논리적 흐름이 전반적으로 양호하나, 결론 도출 과정에서 근거가 다소 부족합니다. 질문 의도를 잘 파악했으나 더 명확한 구조가 필요합니다.",
        "improvement": "결론을 먼저 제시하고 이유를 순서대로 설명하는 두괄식 구조를 연습해 보세요.",
    },
    "specificity": {
        "score": 65,
        "reason": "경험을 언급했지만 구체적인 수치나 기간이 부족합니다. 추상적 표현 비율이 다소 높습니다.",
        "improvement": "수치, 기간, 구체적인 결과를 포함하여 답변을 보강하세요.",
    },
    "job_relevance": {
        "score": 70,
        "reason": "직무와 연관된 경험을 언급했으나 채용공고의 핵심 역량과 직접적인 연결이 부족합니다.",
        "improvement": "지원 직무에서 요구하는 핵심 역량과 본인의 경험을 명확히 연결하세요.",
    },
    "structure": {
        "score": 68,
        "star_breakdown": {
            "situation": True,
            "task": True,
            "action": True,
            "result": False,
        },
        "result_quality": {
            "grade": "vague",
            "comment": "결과 서술이 추상적으로 마무리되어 구체성이 떨어집니다.",
            "improvement": "정량적 수치나 명확한 결과를 포함하여 마무리하세요.",
        },
        "reason": "S/T/A는 갖추어져 있으나 Result가 명확하지 않습니다. 경험의 성과를 더 구체적으로 표현하세요.",
        "improvement": "결과를 수치나 팀의 반응 등 검증 가능한 내용으로 보완하세요.",
    },
    "delivery": {
        "score": 75,
        "filler_count": 3,
        "filler_words": ["음", "그니까", "뭔가"],
        "length_evaluation": {
            "grade": "optimal",
            "char_count": 280,
            "content_density": "medium",
            "comment": "답변 길이는 적절하나 내용 밀도를 높일 여지가 있습니다.",
        },
        "repetition": {
            "detected": True,
            "surface_repetition": {
                "detected": True,
                "examples": ["열심히 - 최선을 다해 - 노력하여"],
            },
            "semantic_repetition": {
                "detected": True,
                "examples": ["같은 의미를 다른 표현으로 반복"],
                "location": "답변 중반부",
            },
            "reason": "유사한 의미의 표현이 반복되어 내용의 밀도가 낮아지고 있습니다.",
            "improvement": "반복되는 표현을 제거하고 새로운 정보를 추가하세요.",
        },
        "reason": "전달력은 양호하지만 간투어와 반복 표현을 줄이면 더 인상적인 답변이 될 수 있습니다.",
        "improvement": "간투어를 줄이고 핵심 내용을 더 간결하게 전달하세요.",
    },
    "overall_comment": "전반적으로 무난한 답변이지만, 구체적인 수치와 명확한 결과 제시가 부족합니다. STAR 구조를 완성하고 간투어를 줄이면 훨씬 인상적인 면접 답변이 될 것입니다.",
}


@router.post("/answers")
def save_answer(body: AnswerCreate):
    with get_db() as conn:
        question = conn.execute(
            "SELECT * FROM questions WHERE id = ?", (body.question_id,)
        ).fetchone()
        if not question:
            raise HTTPException(status_code=404, detail="질문을 찾을 수 없습니다.")

        existing = conn.execute(
            "SELECT id FROM answers WHERE question_id = ?", (body.question_id,)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE answers SET answer_text = ?, recorded_at = datetime('now', 'localtime') WHERE question_id = ?",
                (body.answer_text, body.question_id),
            )
            answer_id = existing["id"]
        else:
            cur = conn.execute(
                "INSERT INTO answers (question_id, answer_text) VALUES (?, ?)",
                (body.question_id, body.answer_text),
            )
            answer_id = cur.lastrowid

    return {"id": answer_id, "question_id": body.question_id}


@router.post("/analysis/{interview_id}")
async def analyze_interview(interview_id: int):
    with get_db() as conn:
        interview = conn.execute(
            "SELECT * FROM interviews WHERE id = ?", (interview_id,)
        ).fetchone()
        if not interview:
            raise HTTPException(status_code=404, detail="면접을 찾을 수 없습니다.")

        questions = conn.execute(
            "SELECT q.*, a.answer_text FROM questions q "
            "LEFT JOIN answers a ON a.question_id = q.id "
            "WHERE q.interview_id = ? ORDER BY q.order_num",
            (interview_id,),
        ).fetchall()

    interview = dict(interview)
    questions = [dict(q) for q in questions]

    answered = [q for q in questions if q.get("answer_text")]
    if not answered:
        raise HTTPException(status_code=400, detail="저장된 답변이 없습니다.")

    job_title = interview["job_title"]
    jd_text = interview.get("jd_text") or ""

    all_feedbacks = []

    if USE_MOCK:
        for q in answered:
            all_feedbacks.append({**MOCK_FEEDBACK, "_question_id": q["id"]})
    else:
        import anthropic
        client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

        system_msg = """당신은 한국어 면접 전문 평가관입니다.
주어진 평가 기준에 따라 면접 답변을 엄격하고 공정하게 평가합니다.

[문맥 평가 기준]
평가 시 반드시 아래 두 가지 수준을 모두 고려하세요:
1. 문장 수준: 각 문장 자체가 문법적으로 올바르고 의미가 명확한가
2. 문맥 수준: 문장들이 서로 자연스럽게 연결되는가
   - 질문 의도와 답변의 전체 방향이 일치하는가
   - 앞 문장의 주제가 뒷 문장으로 자연스럽게 이어지는가
   - 갑작스러운 주제 전환이나 논리 비약이 없는가
   - 각 문장이 개별적으로는 올바르더라도 흐름이 단절되는 경우 감점
   - 결론이 앞의 내용에서 자연스럽게 도출되는가

[STAR 평가 기준]
- S (Situation): 답변의 배경이 되는 상황이 제시되었는가
- T (Task): 본인이 맡은 역할/과제가 명시되었는가
            (팀 전체가 아닌 본인의 책임 범위가 드러나야 함)
- A (Action): 본인이 직접 취한 구체적인 행동이 서술되었는가
- R (Result): 행동의 결과가 언급되었는가
질문 유형을 고려하여 평가하세요.
경험형 질문이 아닌 경우 STAR 구조 미충족을 과도하게 감점하지 마세요.

[Result 질 평가 기준]
- quantitative: 수치/기간/퍼센트 등 정량적 결과 포함
- qualitative:  정량적 수치는 없지만 결과가 명확하게 서술됨
- vague:        결과가 모호하거나 추상적으로만 서술됨

[간투어 탐지 기준]
목록에 의존하지 말고 아래 기준으로 판단하세요:
- 의미 없이 시간을 끄는 표현
- 문장 흐름을 끊는 머뭇거림
- 습관적으로 반복되는 군더더기 표현
예시: "음", "어", "그니까", "솔직히 말하면", "어떻게 보면",
      "뭔가", "약간", "사실" 등
단, 문장 내에서 의미를 가지는 경우는 제외
감점 기준: 0~2회 감점 없음, 3~5회 소폭 감점, 6회 이상 유의미한 감점

[답변 길이 및 내용 밀도 기준]
글자 수는 참고 지표로만 활용:
- 150자 미만이면 너무 짧을 가능성 체크
- 400자 초과면 너무 길 가능성 체크
내용 밀도: high(새 정보 충실) / medium(적절) / low(반복 위주)

[반복 표현 및 의미 중복 탐지 기준]
표현 반복: 동일 단어 3회 이상, 동일 문장 구조, 동일 접속사 3회 이상
의미 중복: 단어가 달라도 동일 의미 반복 서술
단, "저는"은 제외, 의도적 강조는 제외

반드시 JSON 형식으로만 응답하세요. 다른 텍스트는 절대 포함하지 마세요."""

        for q in answered:
            jd_line = f"채용공고: {jd_text}\n" if jd_text.strip() else ""
            user_msg = f"""직무: {job_title}
{jd_line}질문: {q['question_text']}
답변: {q['answer_text']}

채용공고 입력 형식에 관계없이 자격요건과 우대사항을 스스로 파악하여
직무적합성을 평가하세요.
JD가 없는 경우 직무명 기반의 일반적인 역량 기준으로 평가하세요.

다음 기준으로 평가하고 JSON으로 반환하세요:
{{
  "logic": {{
    "score": 0-100,
    "sentence_level": "각 문장 수준의 논리성 평가 (1~2문장)",
    "context_level": "문맥 흐름 및 연결성 평가 (1~2문장)",
    "reason": "종합 평가 이유 (2~3문장)",
    "improvement": "개선 방향 (1~2문장)"
  }},
  "specificity": {{
    "score": 0-100,
    "reason": "평가 이유 (2~3문장)",
    "improvement": "개선 방향 (1~2문장)"
  }},
  "job_relevance": {{
    "score": 0-100,
    "reason": "평가 이유 (2~3문장)",
    "improvement": "개선 방향 (1~2문장)"
  }},
  "structure": {{
    "score": 0-100,
    "star_breakdown": {{
      "situation": true/false,
      "task": true/false,
      "action": true/false,
      "result": true/false
    }},
    "result_quality": {{
      "grade": "quantitative|qualitative|vague",
      "comment": "결과 서술에 대한 평가 (1~2문장)",
      "improvement": "개선 방향 (1문장)"
    }},
    "reason": "종합 평가 이유 (2~3문장)",
    "improvement": "전체 개선 방향 (1~2문장)"
  }},
  "delivery": {{
    "score": 0-100,
    "filler_count": 0,
    "filler_words": [],
    "length_evaluation": {{
      "grade": "too_short|optimal|too_long",
      "char_count": 0,
      "content_density": "high|medium|low",
      "comment": "길이와 밀도를 함께 평가 (1~2문장)"
    }},
    "repetition": {{
      "detected": true/false,
      "surface_repetition": {{
        "detected": true/false,
        "examples": []
      }},
      "semantic_repetition": {{
        "detected": true/false,
        "examples": [],
        "location": ""
      }},
      "reason": "반복 표현 및 의미 중복 종합 평가 (1~2문장)",
      "improvement": "개선 방향 (1문장)"
    }},
    "reason": "전달력 종합 평가 이유 (2~3문장)",
    "improvement": "개선 방향 (1~2문장)"
  }},
  "overall_comment": "종합 총평 — 문맥 흐름 포함하여 2~3문장"
}}"""

            response = client.messages.create(
                model="claude-sonnet-4-5",
                max_tokens=2048,
                system=system_msg,
                messages=[{"role": "user", "content": user_msg}],
            )
            raw = response.content[0].text.strip()
            feedback = json.loads(raw)
            feedback["_question_id"] = q["id"]
            all_feedbacks.append(feedback)

    # 항목별 평균 점수 계산
    def avg_score(key):
        scores = [f[key]["score"] for f in all_feedbacks if key in f]
        return round(sum(scores) / len(scores), 1) if scores else 0

    logic = avg_score("logic")
    specificity = avg_score("specificity")
    job_relevance = avg_score("job_relevance")
    structure = avg_score("structure")
    delivery = avg_score("delivery")
    total = round((logic + specificity + job_relevance + structure + delivery) / 5, 1)

    # 질문별 피드백 저장
    per_question = []
    for fb in all_feedbacks:
        qid = fb.pop("_question_id", None)
        per_question.append({"question_id": qid, "feedback": fb})

    feedback_json = json.dumps(per_question, ensure_ascii=False)

    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM scores WHERE interview_id = ?", (interview_id,)
        ).fetchone()
        if existing:
            conn.execute(
                """UPDATE scores SET logic_score=?, specificity_score=?, job_relevance_score=?,
                   structure_score=?, delivery_score=?, total_score=?, feedback_json=?
                   WHERE interview_id=?""",
                (logic, specificity, job_relevance, structure, delivery, total, feedback_json, interview_id),
            )
        else:
            conn.execute(
                """INSERT INTO scores (interview_id, logic_score, specificity_score, job_relevance_score,
                   structure_score, delivery_score, total_score, feedback_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (interview_id, logic, specificity, job_relevance, structure, delivery, total, feedback_json),
            )
        conn.execute(
            "UPDATE interviews SET total_score=?, status='completed' WHERE id=?",
            (total, interview_id),
        )

    return {"interview_id": interview_id, "total_score": total}


@router.get("/result/{interview_id}")
def get_result(interview_id: int):
    with get_db() as conn:
        interview = conn.execute(
            "SELECT * FROM interviews WHERE id = ?", (interview_id,)
        ).fetchone()
        if not interview:
            raise HTTPException(status_code=404, detail="면접을 찾을 수 없습니다.")

        score_row = conn.execute(
            "SELECT * FROM scores WHERE interview_id = ?", (interview_id,)
        ).fetchone()

        questions = conn.execute(
            "SELECT q.*, a.answer_text FROM questions q "
            "LEFT JOIN answers a ON a.question_id = q.id "
            "WHERE q.interview_id = ? ORDER BY q.order_num",
            (interview_id,),
        ).fetchall()

    if not score_row:
        raise HTTPException(status_code=404, detail="분석 결과가 없습니다. 먼저 분석을 실행하세요.")

    score_row = dict(score_row)
    feedback_list = json.loads(score_row.get("feedback_json") or "[]")

    return {
        **dict(interview),
        "scores": {
            "logic": score_row["logic_score"],
            "specificity": score_row["specificity_score"],
            "job_relevance": score_row["job_relevance_score"],
            "structure": score_row["structure_score"],
            "delivery": score_row["delivery_score"],
            "total": score_row["total_score"],
        },
        "feedbacks": feedback_list,
        "questions": [dict(q) for q in questions],
    }

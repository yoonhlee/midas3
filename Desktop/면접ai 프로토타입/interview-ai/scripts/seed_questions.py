"""면접 질문 시드 데이터 스크립트.

실행: python scripts/seed_questions.py
"""
import asyncio
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.chdir(os.path.join(os.path.dirname(__file__), ".."))

from app.core.database import AsyncSessionLocal
from app.models.question import Question

SEED_QUESTIONS = [
    # ============================
    # 경험 (2문항)
    # ============================
    {
        "category": "경험",
        "subcategory": "어려운 프로젝트",
        "question_text": "지원하신 직무에서 가장 어려웠던 프로젝트 경험을 말씀해 주세요. 어떤 어려움이 있었고, 어떻게 극복하셨나요?",
        "expected_star_applicable": True,
        "difficulty_level": 2,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅", "영업"],
    },
    {
        "category": "경험",
        "subcategory": "팀 갈등 해결",
        "question_text": "팀원과 의견 충돌이 생겼던 경험을 말씀해 주세요. 어떻게 해결하셨나요?",
        "expected_star_applicable": True,
        "difficulty_level": 2,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅", "영업", "인사"],
    },
    {
        "category": "경험",
        "subcategory": "성공 경험",
        "question_text": "본인이 주도적으로 추진해서 성공적으로 완료한 프로젝트나 업무 경험을 구체적으로 설명해 주세요.",
        "expected_star_applicable": True,
        "difficulty_level": 2,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅"],
    },
    {
        "category": "경험",
        "subcategory": "실패 경험",
        "question_text": "업무나 프로젝트에서 실패했던 경험을 말씀해 주세요. 그 경험에서 무엇을 배우셨나요?",
        "expected_star_applicable": True,
        "difficulty_level": 3,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅", "영업"],
    },
    {
        "category": "경험",
        "subcategory": "성과 개선",
        "question_text": "기존 방식을 개선하거나 프로세스를 혁신하여 성과를 높인 경험이 있으신가요? 구체적으로 설명해 주세요.",
        "expected_star_applicable": True,
        "difficulty_level": 3,
        "job_categories": ["데이터분석", "개발", "기획", "운영"],
    },
    {
        "category": "경험",
        "subcategory": "협업 경험",
        "question_text": "다른 부서 또는 외부 파트너와 협업했던 경험을 말씀해 주세요. 어떤 역할을 담당하셨나요?",
        "expected_star_applicable": True,
        "difficulty_level": 2,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅", "영업", "인사"],
    },
    # ============================
    # 역량
    # ============================
    {
        "category": "역량",
        "subcategory": "강점/약점",
        "question_text": "본인의 가장 큰 강점과 약점은 무엇인지, 각각 구체적인 사례를 들어 설명해 주세요.",
        "expected_star_applicable": False,
        "difficulty_level": 1,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅", "영업", "인사"],
    },
    {
        "category": "역량",
        "subcategory": "리더십",
        "question_text": "팀이나 프로젝트를 이끌었던 경험 중 리더십을 가장 잘 발휘했다고 생각하는 사례를 말씀해 주세요.",
        "expected_star_applicable": True,
        "difficulty_level": 3,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅", "영업", "인사"],
    },
    {
        "category": "역량",
        "subcategory": "문제 해결",
        "question_text": "복잡한 문제를 분석하고 창의적인 해결책을 제시했던 경험을 구체적으로 설명해 주세요.",
        "expected_star_applicable": True,
        "difficulty_level": 3,
        "job_categories": ["데이터분석", "개발", "기획"],
    },
    {
        "category": "역량",
        "subcategory": "커뮤니케이션",
        "question_text": "어려운 내용을 비전문가에게 쉽게 설명했던 경험이 있으신가요? 어떻게 전달하셨나요?",
        "expected_star_applicable": True,
        "difficulty_level": 2,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅"],
    },
    # ============================
    # 상황 (Situational)
    # ============================
    {
        "category": "상황",
        "subcategory": "돌발 상황 대처",
        "question_text": "업무 중 예상치 못한 문제나 위기 상황이 발생했을 때 어떻게 대처하셨나요? 구체적인 사례를 들어주세요.",
        "expected_star_applicable": True,
        "difficulty_level": 3,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅", "영업", "운영"],
    },
    {
        "category": "상황",
        "subcategory": "압박 상황",
        "question_text": "촉박한 마감 기한이나 높은 압박 상황에서 어떻게 업무를 처리하셨나요?",
        "expected_star_applicable": True,
        "difficulty_level": 3,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅", "영업"],
    },
    {
        "category": "상황",
        "subcategory": "의사결정",
        "question_text": "불완전한 정보 속에서 중요한 의사결정을 내려야 했던 경험을 말씀해 주세요. 어떤 기준으로 판단하셨나요?",
        "expected_star_applicable": True,
        "difficulty_level": 4,
        "job_categories": ["데이터분석", "기획", "영업", "인사"],
    },
    {
        "category": "상황",
        "subcategory": "우선순위",
        "question_text": "여러 업무가 동시에 주어졌을 때 우선순위를 어떻게 정하고 처리하셨나요?",
        "expected_star_applicable": False,
        "difficulty_level": 2,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅", "영업", "운영"],
    },
    # ============================
    # 직무지식
    # ============================
    {
        "category": "직무지식",
        "subcategory": "데이터 분석",
        "question_text": "데이터 분석 업무에서 가장 중요하다고 생각하는 역량은 무엇이며, 그 이유는 무엇인가요?",
        "expected_star_applicable": False,
        "difficulty_level": 2,
        "job_categories": ["데이터분석"],
    },
    {
        "category": "직무지식",
        "subcategory": "기술 트렌드",
        "question_text": "최근 본인의 직무 분야에서 가장 관심 있게 따라가고 있는 기술 트렌드나 이슈는 무엇인가요?",
        "expected_star_applicable": False,
        "difficulty_level": 2,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅"],
    },
    {
        "category": "직무지식",
        "subcategory": "방법론",
        "question_text": "지원 직무와 관련하여 본인이 가장 능숙하게 사용하는 방법론이나 도구는 무엇인가요? 어떻게 활용하셨나요?",
        "expected_star_applicable": False,
        "difficulty_level": 2,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅"],
    },
    # ============================
    # 인성
    # ============================
    {
        "category": "인성",
        "subcategory": "지원 동기",
        "question_text": "저희 회사와 이 직무에 지원하게 된 구체적인 이유를 말씀해 주세요.",
        "expected_star_applicable": False,
        "difficulty_level": 1,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅", "영업", "인사", "운영"],
    },
    {
        "category": "인성",
        "subcategory": "5년 후 목표",
        "question_text": "5년 후 본인의 모습은 어떠할 것 같으신가요? 어떤 목표를 갖고 계신지 말씀해 주세요.",
        "expected_star_applicable": False,
        "difficulty_level": 1,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅", "영업", "인사", "운영"],
    },
    {
        "category": "인성",
        "subcategory": "직업관",
        "question_text": "일을 함에 있어 가장 중요하게 생각하는 가치관은 무엇인지, 그리고 그 이유를 설명해 주세요.",
        "expected_star_applicable": False,
        "difficulty_level": 1,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅", "영업", "인사", "운영"],
    },
    {
        "category": "인성",
        "subcategory": "자기계발",
        "question_text": "최근 1년 동안 본인의 역량 향상을 위해 어떤 노력을 하셨나요?",
        "expected_star_applicable": False,
        "difficulty_level": 1,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅", "영업", "인사"],
    },
    {
        "category": "인성",
        "subcategory": "입사 후 포부",
        "question_text": "입사 후 첫 6개월 동안 어떤 부분에 집중하고 싶으신가요? 구체적인 계획을 말씀해 주세요.",
        "expected_star_applicable": False,
        "difficulty_level": 2,
        "job_categories": ["데이터분석", "개발", "기획", "마케팅", "영업", "인사", "운영"],
    },
]


async def seed():
    print(f"시드 데이터 {len(SEED_QUESTIONS)}개 삽입 시작...")
    async with AsyncSessionLocal() as db:
        for q_data in SEED_QUESTIONS:
            existing = await db.execute(
                __import__("sqlalchemy", fromlist=["select"]).select(Question).where(
                    Question.question_text == q_data["question_text"]
                )
            )
            if existing.scalar_one_or_none():
                print(f"  SKIP (이미 존재): {q_data['question_text'][:40]}...")
                continue

            q = Question(**q_data)
            db.add(q)
            print(f"  ADD [{q_data['category']}] {q_data['question_text'][:40]}...")

        await db.commit()
    print("시드 데이터 삽입 완료!")


if __name__ == "__main__":
    asyncio.run(seed())

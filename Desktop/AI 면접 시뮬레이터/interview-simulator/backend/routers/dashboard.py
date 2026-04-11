import json
from fastapi import APIRouter
from database import get_db

router = APIRouter()


@router.get("/dashboard")
def get_dashboard():
    with get_db() as conn:
        interviews = conn.execute(
            """SELECT i.id, i.job_title, i.created_at, i.total_score, i.status,
                      s.logic_score, s.specificity_score, s.job_relevance_score,
                      s.structure_score, s.delivery_score
               FROM interviews i
               LEFT JOIN scores s ON s.interview_id = i.id
               WHERE i.status = 'completed'
               ORDER BY i.created_at DESC
               LIMIT 20""",
        ).fetchall()

    result = []
    for row in interviews:
        r = dict(row)
        result.append({
            "id": r["id"],
            "job_title": r["job_title"],
            "created_at": r["created_at"],
            "total_score": r["total_score"],
            "scores": {
                "logic": r["logic_score"],
                "specificity": r["specificity_score"],
                "job_relevance": r["job_relevance_score"],
                "structure": r["structure_score"],
                "delivery": r["delivery_score"],
            },
        })

    return {"interviews": result}

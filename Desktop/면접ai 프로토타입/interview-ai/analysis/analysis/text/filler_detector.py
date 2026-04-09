"""추임새(간투어) 탐지 모듈."""
import re
from typing import Any, Dict, List

import structlog

logger = structlog.get_logger(__name__)

# 추임새 패턴 사전
# context_check=True이면 주변 문맥을 통해 실제 추임새인지 추가 판별
FILLER_PATTERNS = {
    "어": {"pos_tags": {"IC"}, "context_check": True},
    "음": {"pos_tags": {"IC"}, "context_check": True},
    "그": {"pos_tags": {"IC"}, "context_check": True},       # 지시대명사 '그' 제외
    "이제": {"pos_tags": {"MAG"}, "context_check": True},
    "약간": {"pos_tags": {"MAG"}, "context_check": True},
    "뭐": {"pos_tags": {"NP", "IC"}, "context_check": True},
    "좀": {"pos_tags": {"MAG"}, "context_check": False},
    "그냥": {"pos_tags": {"MAG"}, "context_check": False},
    "되게": {"pos_tags": {"MAG"}, "context_check": False},
    "막": {"pos_tags": {"MAG"}, "context_check": True},
    "뭔가": {"pos_tags": {"NP"}, "context_check": False},
    "아무튼": {"pos_tags": {"MAJ"}, "context_check": False},
    "사실은": {"pos_tags": {"MAG"}, "context_check": True},
    "솔직히": {"pos_tags": {"MAG"}, "context_check": True},
}

# 문맥 없이 독립적으로 사용되는 추임새 정규식 패턴
STANDALONE_FILLER_RE = re.compile(
    r'(?<![가-힣a-zA-Z])(어|음|에|아|으음|흠|응)(?![가-힣a-zA-Z])'
)


class FillerWordDetector:
    """추임새 탐지 — Kiwi 품사 태그 + 정규식 조합."""

    def detect(self, text: str, tokens: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        추임새 탐지.

        Args:
            text: 원본 텍스트
            tokens: Kiwi 형태소 분석 결과

        Returns:
            {
                "total": int,
                "ratio": float,
                "details": [{"word": str, "count": int, "positions": [int]}]
            }
        """
        word_count = len(text.split())
        filler_counts: Dict[str, Dict[str, Any]] = {}

        # 1. 형태소 기반 탐지
        for token in tokens:
            form = token["form"]
            tag = token["tag"]

            if form in FILLER_PATTERNS:
                pattern_info = FILLER_PATTERNS[form]
                allowed_tags = pattern_info["pos_tags"]
                if tag in allowed_tags:
                    # context_check=True이면 단독 사용 여부 체크
                    if pattern_info["context_check"]:
                        if not self._is_standalone_filler(text, token):
                            continue
                    if form not in filler_counts:
                        filler_counts[form] = {"count": 0, "positions": []}
                    filler_counts[form]["count"] += 1
                    filler_counts[form]["positions"].append(token["start"])

        # 2. 정규식 기반 독립 추임새 탐지 (형태소 미탐지 보완)
        for m in STANDALONE_FILLER_RE.finditer(text):
            word = m.group()
            if word not in filler_counts:
                filler_counts[word] = {"count": 0, "positions": []}
            filler_counts[word]["count"] += 1
            filler_counts[word]["positions"].append(m.start())

        total = sum(v["count"] for v in filler_counts.values())
        ratio = total / word_count if word_count > 0 else 0.0

        details = [
            {"word": w, "count": v["count"], "positions": v["positions"]}
            for w, v in sorted(filler_counts.items(), key=lambda x: -x[1]["count"])
        ]

        return {
            "total": total,
            "ratio": round(ratio, 4),
            "details": details,
        }

    def _is_standalone_filler(self, text: str, token: Dict[str, Any]) -> bool:
        """해당 토큰이 단독 추임새로 사용되는지 판별."""
        start = token["start"]
        end = token.get("end", start + len(token["form"]))
        context_window = 3  # 앞뒤 3글자 확인

        before = text[max(0, start - context_window):start].strip()
        after = text[end:end + context_window].strip()

        # 앞뒤에 다른 내용 없이 독립적으로 사용되면 추임새
        if not before or before[-1] in ",.?!。，。":
            return True
        if not after or after[0] in ",.?!。，。":
            return True
        return False

    def highlight_transcript(self, text: str, filler_data: Dict[str, Any]) -> str:
        """전사문에 추임새 하이라이트 마크업 추가."""
        filler_words = {d["word"] for d in filler_data.get("details", [])}
        if not filler_words:
            return text

        pattern = re.compile(
            r'(?<![가-힣])(' + '|'.join(re.escape(w) for w in filler_words) + r')(?![가-힣])'
        )
        return pattern.sub(r"<mark class='filler'>\1</mark>", text)

"""자기 수정 패턴 탐지 모듈."""
import re
from typing import Any, Dict, List

CORRECTION_PATTERNS = [
    r"아\s*아니[요라]?",
    r"다시\s*말하[면자]",
    r"아니\s*그러니까",
    r"잘못\s*말했",
    r"아\s*그게\s*아니라",
    r"정정하[면자]",
    r"제가\s*잘못",
    r"취소하고",
    r"아니\s*제가",
    r"아\s*죄송",
]

_COMPILED = [re.compile(p) for p in CORRECTION_PATTERNS]


class SelfCorrectionDetector:
    """자기 수정 표현 탐지."""

    def detect(self, text: str) -> Dict[str, Any]:
        """
        Returns:
            {"count": int, "details": [{"pattern": str, "matched_text": str, "position": int}]}
        """
        details: List[Dict[str, Any]] = []

        for pattern_re, pattern_str in zip(_COMPILED, CORRECTION_PATTERNS):
            for m in pattern_re.finditer(text):
                details.append({
                    "pattern": pattern_str,
                    "matched_text": m.group(),
                    "position": m.start(),
                })

        return {
            "count": len(details),
            "details": sorted(details, key=lambda x: x["position"]),
        }

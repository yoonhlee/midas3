"""Kiwi 형태소 분석기 기반 텍스트 전처리 모듈."""
from typing import Any, Dict, List, Optional, Tuple

import structlog

logger = structlog.get_logger(__name__)


class TextPreprocessor:
    """Kiwi를 사용하여 한국어 텍스트 전처리."""

    def __init__(self):
        self._kiwi = None

    def _load_kiwi(self):
        if self._kiwi is not None:
            return
        try:
            from kiwipiepy import Kiwi
            self._kiwi = Kiwi()
            logger.info("Kiwi loaded")
        except ImportError:
            logger.warning("kiwipiepy not installed, using simple tokenizer")

    def analyze(self, text: str) -> Dict[str, Any]:
        """
        텍스트 형태소 분석 및 문장 분리.

        Returns:
            {
                "sentences": [str],
                "tokens": [{"form": str, "tag": str, "start": int, "end": int}],
                "word_count": int,
                "sentence_count": int,
                "avg_sentence_length": float,
            }
        """
        self._load_kiwi()

        if self._kiwi is None:
            return self._simple_analyze(text)

        try:
            # 문장 분리
            sentences = [sent.text for sent in self._kiwi.split_into_sents(text)]

            # 형태소 분석
            result = self._kiwi.analyze(text)
            tokens = []
            if result:
                for token in result[0].tokens:
                    tokens.append({
                        "form": token.form,
                        "tag": str(token.tag),
                        "start": token.start,
                        "end": token.start + token.len,
                    })

            word_count = len(text.split())
            sentence_count = len(sentences)
            avg_sentence_length = word_count / sentence_count if sentence_count > 0 else 0

            return {
                "sentences": sentences,
                "tokens": tokens,
                "word_count": word_count,
                "sentence_count": sentence_count,
                "avg_sentence_length": round(avg_sentence_length, 2),
            }
        except Exception as e:
            logger.error("Kiwi analysis failed", error=str(e))
            return self._simple_analyze(text)

    def _simple_analyze(self, text: str) -> Dict[str, Any]:
        """Kiwi 없을 때 단순 분석."""
        sentences = [s.strip() for s in text.replace(".", ". ").split(". ") if s.strip()]
        words = text.split()
        return {
            "sentences": sentences,
            "tokens": [{"form": w, "tag": "NNG", "start": 0, "end": 0} for w in words],
            "word_count": len(words),
            "sentence_count": len(sentences),
            "avg_sentence_length": len(words) / len(sentences) if sentences else 0,
        }

    def get_nouns(self, tokens: List[Dict[str, Any]]) -> List[str]:
        """명사 목록 추출."""
        noun_tags = {"NNG", "NNP", "NNB", "NR", "NP"}
        return [t["form"] for t in tokens if t["tag"] in noun_tags]

    def get_numbers(self, text: str) -> List[str]:
        """수치 표현 추출 (숫자 + 단위)."""
        import re
        patterns = [
            r'\d+(?:\.\d+)?(?:%|퍼센트|배|명|개|회|년|월|일|시간|분|초|억|만|천|백)',
            r'\d+(?:\.\d+)?',
        ]
        results = []
        for p in patterns:
            results.extend(re.findall(p, text))
        return list(set(results))


preprocessor = TextPreprocessor()

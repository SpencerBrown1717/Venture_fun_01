"""Heuristic AI-relatedness classifier.

Design goals:
  * Zero dependencies / fully offline, so the pipeline always produces a score.
  * Transparent: every score comes with the exact signals that produced it,
    which matters for investor trust and debugging false positives.
  * Calibrated 0..1 confidence via a logistic squash over weighted evidence.
  * Subsector tagging so the dashboard can group AI companies by theme.

The taxonomy is intentionally tiered: strong terms ("large language model")
contribute more than weak/ambiguous ones ("smart", "AI" as a bare token, which
also matches non-AI usage). We also guard against false positives like
"Mountain AIr" by matching whole words/phrases.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

from ..models import Company

# (phrase, weight). Phrases are matched as whole tokens, case-insensitively.
STRONG_SIGNALS: list[tuple[str, float]] = [
    ("artificial intelligence", 3.0),
    ("machine learning", 3.0),
    ("deep learning", 3.0),
    ("large language model", 3.5),
    ("large language models", 3.5),
    ("generative ai", 3.5),
    ("foundation model", 3.0),
    ("neural network", 2.8),
    ("computer vision", 2.8),
    ("natural language processing", 2.8),
    ("reinforcement learning", 2.8),
    ("autonomous agent", 3.0),
    ("ai agent", 3.0),
    ("agentic", 3.0),
    ("llm", 2.5),
    ("genai", 3.0),
    ("transformer model", 2.8),
    ("diffusion model", 2.8),
    ("inference engine", 2.2),
    ("vector database", 2.2),
    ("ml ops", 2.0),
    ("mlops", 2.0),
]

WEAK_SIGNALS: list[tuple[str, float]] = [
    ("ai", 1.2),               # bare token; whole-word matched
    ("a.i.", 1.2),
    ("ml", 0.8),
    ("intelligence", 0.6),
    ("neural", 1.5),
    ("cognitive", 1.0),
    ("predictive", 0.9),
    ("automation", 0.6),
    ("autonomous", 1.2),
    ("copilot", 1.4),
    ("chatbot", 1.4),
    ("model", 0.3),
    ("data science", 1.0),
    ("smart", 0.3),
    ("robotics", 1.3),
    ("perception", 0.8),
]

# Subsector -> indicative phrases. Matching is boundary-aware and score-based:
# the category with the most keyword hits wins (ties broken by this order), so a
# single generic word can't hijack the label. Keywords are treated as prefixes
# (e.g. "diagnos" -> "diagnosis"/"diagnostic") but respect a left word boundary,
# so "compute" no longer matches inside "computer".
CATEGORIES: list[tuple[str, list[str]]] = [
    ("Robotics", ["robot", "drone", "autonomous vehicle", "autonomous mobile",
                  "manipulation", "warehouse picking"]),
    ("Computer Vision", ["computer vision", "vision", "image recognition", "perception",
                         "video", "defect detection", "object detection", "camera"]),
    ("NLP / Language", ["language model", "llm", "nlp", "natural language", "speech",
                        "voice", "translation", "contract review"]),
    ("Generative Media", ["generative", "image generation", "video synthesis", "synthesis",
                          "avatar", "content generation", "text-to"]),
    ("AI Agents", ["agentic", "autonomous agent", "ai agent", "ai agents", "workflow automation",
                   "long-horizon", "tool use"]),
    ("Healthcare AI", ["clinical", "diagnos", "patient", "drug discovery", "medical",
                       "healthcare", "protein", "telehealth", "triage"]),
    ("Fintech AI", ["fraud", "trading", "credit risk", "fintech", "underwriting",
                    "payments", "lending", "insurance"]),
    ("AI Infrastructure", ["gpu", "inference", "vector database", "mlops", "ml ops",
                           "model serving", "fine-tun", "data center", "accelerator",
                           "retrieval", "rag", "drift detection"]),
    ("Developer Tools", ["copilot", "code", "developer", "sdk", "pair programmer",
                         "devtool", "ide", "pull request"]),
    ("Data / Analytics", ["analytics", "data science", "predictive analytics", "forecast",
                          "insight", "demand model"]),
]

THRESHOLD = 0.5  # is_ai cutoff on the 0..1 score


@dataclass
class HeuristicClassifier:
    threshold: float = THRESHOLD

    def classify(self, company: Company) -> Company:
        text_fields = {
            "name": company.name or "",
            "website": company.website or "",
            "description": company.description or "",
        }
        # Name matches matter more than description matches.
        field_weight = {"name": 1.6, "website": 1.1, "description": 1.0}

        score_accum = 0.0
        signals: list[str] = []

        for field_name, text in text_fields.items():
            lowered = text.lower()
            for phrase, weight in STRONG_SIGNALS + WEAK_SIGNALS:
                if self._matches(phrase, lowered):
                    contribution = weight * field_weight[field_name]
                    score_accum += contribution
                    signals.append(f"{phrase} ({field_name})")

        confidence = self._squash(score_accum)
        company.ai_score = round(confidence, 4)
        company.is_ai = confidence >= self.threshold
        # De-duplicate signals while preserving order.
        company.ai_signals = list(dict.fromkeys(signals))
        company.ai_category = self._categorize(
            " ".join(text_fields.values()).lower()
        ) if company.is_ai else ""
        return company

    @staticmethod
    def _matches(phrase: str, text: str) -> bool:
        # whole-word / whole-phrase, escaping regex metachars (e.g. "a.i.")
        pattern = r"(?<![a-z0-9])" + re.escape(phrase) + r"(?![a-z0-9])"
        return re.search(pattern, text) is not None

    @staticmethod
    def _squash(x: float) -> float:
        """Logistic squash centered so ~one strong signal -> high confidence.

        f(0)=0, rises steeply; 1 strong name hit (~4.8) -> ~0.83.
        """
        if x <= 0:
            return 0.0
        return 1.0 / (1.0 + math.exp(-(x - 2.0)))

    @staticmethod
    def _categorize(text: str) -> str:
        """Score-based: the category with the most keyword hits wins.

        Keywords match as prefixes but require a left word boundary, so generic
        substrings (e.g. "compute" in "computer") don't trigger false matches.
        """
        best_cat, best_score, best_rank = "General AI", 0, len(CATEGORIES)
        for rank, (category, keywords) in enumerate(CATEGORIES):
            score = sum(
                1
                for kw in keywords
                if re.search(r"(?<![a-z0-9])" + re.escape(kw), text)
            )
            if score > best_score or (score == best_score and score > 0 and rank < best_rank):
                best_cat, best_score, best_rank = category, score, rank
        return best_cat if best_score > 0 else "General AI"

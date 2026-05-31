"""Reporting Agent (stretch goal 3 — the swarm's final word).

Synthesizes the outputs of the other agents (classifier, research, founders,
scoring, market) into a single investor-facing recommendation: a verdict, a
conviction level, and a short rationale that cites the strongest and weakest
signals. This is what turns a pile of analysis into a decision.
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import Company

VERDICTS = [
    (78, "Strong interest"),
    (66, "Track closely"),
    (52, "Monitor"),
    (0, "Pass for now"),
]

PRETTY = {
    "team_quality": "team", "market_size": "market size",
    "product_differentiation": "differentiation", "technical_complexity": "technical depth",
    "defensibility": "defensibility", "timing": "timing",
}


@dataclass
class ReportingAgent:
    def report(self, company: Company) -> Company:
        scores = company.scores or {}
        dims = scores.get("dimensions", {})
        overall = scores.get("overall", int(company.ai_score * 60))
        confidence = scores.get("confidence", round(company.ai_score, 2))

        verdict = next(label for cutoff, label in VERDICTS if overall >= cutoff)

        ranked = sorted(dims.items(), key=lambda kv: kv[1]["score"], reverse=True)
        strengths = [PRETTY.get(k, k) for k, _ in ranked[:2]]
        weakness = PRETTY.get(ranked[-1][0], ranked[-1][0]) if ranked else "execution"

        leaders = (company.competitive or {}).get("leaders", [])[:3]
        comp_clause = (
            f" Competes with {', '.join(leaders)}." if leaders else ""
        )
        founder_clause = ""
        if company.founders:
            f0 = company.founders[0]
            founder_clause = f" Led by {f0['name']} ({f0['role']})."

        rationale = (
            f"Overall opportunity score {overall}/100 (confidence {int(confidence*100)}%). "
            f"Strongest on {strengths[0]}"
            + (f" and {strengths[1]}" if len(strengths) > 1 else "")
            + f"; watch {weakness}.{founder_clause}{comp_clause}"
        )

        # conviction blends the model's opportunity score with evidence confidence
        conviction = round(min(0.97, (overall / 100) * 0.7 + confidence * 0.3), 2)

        company.recommendation = {
            "verdict": verdict,
            "conviction": conviction,
            "overall": overall,
            "rationale": rationale,
        }
        return company

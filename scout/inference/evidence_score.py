"""Evidence score, badges, and missing-data checklist.

Evidence score measures *how much we know* (record provenance), deliberately
separate from the opportunity score (how interesting the company looks). Weak
evidence must never masquerade as high confidence.
"""

from __future__ import annotations

WEIGHTS = {
    "sec_form_d": 25,
    "state_incorporation": 20,
    "accelerator": 20,
    "website": 15,
    "founder_profile": 15,
    "job_posting": 10,
    "product_launch": 10,
}


def evidence_score(company, records: list[dict]) -> int:
    score = 0
    types = [r["source_type"] for r in records]
    for t in set(types):
        score += WEIGHTS.get(t, 0)

    distinct = len({t for t in types})
    if distinct >= 3:
        score += 10  # corroborated by multiple independent sources
    if company.ai_category:
        score += 5
    if company.formation_date:
        score += 5

    if not records:
        score -= 20  # name-only
    if not company.website_verified:
        score -= 10
    if not company.founders:
        score -= 10

    return max(0, min(100, score))


def evidence_confidence(score: int) -> str:
    if score >= 70:
        return "High"
    if score >= 45:
        return "Medium"
    if score >= 25:
        return "Medium-low"
    return "Low"


def badges(company, records: list[dict]) -> list[str]:
    out: list[str] = []
    types = {r["source_type"] for r in records}

    if company.form_d_found:
        out.append("Confirmed Form D")
    else:
        out.append("No Form D found")
    if company.probable_safe_stage:
        out.append("Probable SAFE-stage")
    if "accelerator" in types:
        out.append("Accelerator-backed")
    if company.website_verified:
        out.append("Website verified")
    if company.founders:
        out.append("Founder verified")
    if "job_posting" in types:
        out.append("Hiring signal")
    if "product_launch" in types:
        out.append("Product launched")
    if company.raw.get("top_company"):
        out.append("Top company")
    if company.source_tier >= 5:
        out.append("Weak signal · needs review")
    return out


def missing_data(company, records: list[dict]) -> list[str]:
    types = {r["source_type"] for r in records}
    checklist: list[tuple[str, bool]] = [
        ("Form D / financing check", company.form_d_found),
        ("Website verified", bool(company.website_verified)),
        ("Founder verification", bool(company.founders)),
        ("Accelerator check", "accelerator" in types),
        ("Hiring / jobs scan", "job_posting" in types),
        ("Product launch check", "product_launch" in types),
    ]
    return [label for label, present in checklist if not present]

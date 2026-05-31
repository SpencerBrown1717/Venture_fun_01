"""Inference layer: turn raw signals into transparent, labeled intelligence.

This is the heart of the "Pre-Form-D Radar" upgrade. It separates two ideas the
old pipeline conflated:

  * **evidence_score**  — how much independent public evidence supports a record
  * **opportunity_score** — how interesting the company looks (already produced
                            by the scoring agent for AI companies)

It also assigns a transparent **source tier**, a **financing-stage inference**
(never claiming a SAFE was confirmed), and human-readable **badges** — all
derived from `source_records` so every claim is auditable.
"""

from __future__ import annotations

from .source_tier import source_tier
from .financing_stage import financing_stage
from .evidence_score import evidence_score, badges, missing_data
from .records import build_source_records, domain_of

__all__ = [
    "apply_intelligence",
    "source_tier", "financing_stage", "evidence_score",
    "badges", "missing_data", "build_source_records", "domain_of",
]


def apply_intelligence(company) -> None:
    """Populate the inference fields on a Company (idempotent, fail-soft)."""
    records = build_source_records(company)
    company.source_records = records
    company.domain = domain_of(company)

    has_form_d = any(r["source_type"] in ("sec_form_d", "state_incorporation") for r in records)
    company.form_d_found = bool(company.raw.get("cik")) or has_form_d

    stage, probable_safe = financing_stage(company, records)
    company.financing_stage = stage
    company.probable_safe_stage = probable_safe

    company.source_tier = source_tier(records)
    company.evidence_score = evidence_score(company, records)
    company.badges = badges(company, records)

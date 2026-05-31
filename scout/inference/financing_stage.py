"""Financing-stage inference.

CRITICAL: we never claim a SAFE was raised. "Probable SAFE-stage" means the
company shows early-startup signals but *no public Form D was found* — it is an
inference about visibility, not a confirmed financing event.
"""

from __future__ import annotations

CONFIRMED = "Confirmed Form D"
SAFE = "Probable SAFE-stage"
SAFE_OR_BOOT = "Probable SAFE-stage or bootstrapped"
EARLY = "Pre-Form-D / early signal"
WEAK = "Weak unverified signal"
UNKNOWN = "Unknown financing status"


def financing_stage(company, records: list[dict]) -> tuple[str, bool]:
    """Return (label, probable_safe_stage)."""
    types = {r["source_type"] for r in records}

    if types & {"sec_form_d", "state_incorporation"} and company.raw.get("cik"):
        return CONFIRMED, False

    has_accel = "accelerator" in types
    has_site = "website" in types
    has_founder = "founder_profile" in types
    has_jobs = "job_posting" in types
    has_launch = "product_launch" in types
    has_domain = bool(company.domain)

    if has_accel:
        return SAFE, True
    if has_site and has_founder and has_jobs:
        return SAFE, True
    if has_jobs and has_site:
        return SAFE_OR_BOOT, True
    if has_site and has_founder:
        return EARLY, True
    if has_launch and has_site:
        return EARLY, True
    if has_domain and not (has_site or has_founder):
        return WEAK, False
    return UNKNOWN, False

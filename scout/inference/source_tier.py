"""Transparent source-tier model.

Tier 1: SEC Form D confirmed
Tier 2: Accelerator / demo day confirmed
Tier 3: Website + founder identity confirmed
Tier 4: Domain + job/launch signal
Tier 5: Name-only / weak signal
"""

from __future__ import annotations

TIER_LABELS = {
    1: "SEC Form D confirmed",
    2: "Accelerator confirmed",
    3: "Website + founder confirmed",
    4: "Domain + job signal",
    5: "Weak / name-only signal",
}


def source_tier(records: list[dict]) -> int:
    types = {r["source_type"] for r in records}
    if {"sec_form_d", "state_incorporation"} & types:
        return 1
    if "accelerator" in types:
        return 2
    if "website" in types and "founder_profile" in types:
        return 3
    if types & {"website", "job_posting", "product_launch"}:
        return 4
    return 5

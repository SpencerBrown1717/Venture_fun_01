"""Conservative company de-duplication over exported dicts."""

from __future__ import annotations

import re

_SUFFIXES = {"inc", "incorporated", "llc", "corp", "corporation", "co", "ltd",
             "limited", "lp", "llp", "the", "ai", "labs", "technologies", "technology"}


def normalize_name(name: str) -> str:
    tokens = re.sub(r"[^a-z0-9\s]", " ", (name or "").lower()).split()
    tokens = [t for t in tokens if t not in _SUFFIXES]
    return " ".join(tokens).strip()


def _tier(c: dict) -> int:
    return c.get("source_tier") or (1 if c.get("form_d_found") else 5)


def _merge(primary: dict, other: dict) -> dict:
    """Fold `other` into `primary` (primary is the more authoritative record)."""
    p = dict(primary)
    # Union provenance + badges.
    recs = list(p.get("source_records") or [])
    seen = {(r.get("source_type"), r.get("source_url")) for r in recs}
    for r in other.get("source_records") or []:
        if (r.get("source_type"), r.get("source_url")) not in seen:
            recs.append(r)
    p["source_records"] = recs
    p["badges"] = sorted(set((p.get("badges") or []) + (other.get("badges") or [])))
    p["evidence_score"] = max(p.get("evidence_score", 0), other.get("evidence_score", 0))
    p["source_tier"] = min(_tier(p), _tier(other))
    # Fill gaps from the other record.
    for key in ("website", "domain", "ai_category", "memo", "scores", "competitive",
                "recommendation", "description"):
        if not p.get(key) and other.get(key):
            p[key] = other[key]
    if not p.get("founders") and other.get("founders"):
        p["founders"] = other["founders"]
    if other.get("website_verified") and not p.get("website_verified"):
        p["website_verified"] = True
        p["website"] = other.get("website") or p.get("website")
    p["merged_from"] = (p.get("merged_from") or []) + [other.get("source")]
    return p


def dedupe(companies: list[dict]) -> tuple[list[dict], int]:
    """Merge duplicates. Returns (companies, merged_count).

    Match rules (conservative):
      * same non-empty domain → merge
      * same normalized name across *different* sources → merge
        (one startup in both the accelerator feed and a Form D filing)
    """
    by_domain: dict[str, int] = {}
    by_xname: dict[str, int] = {}     # normalized name -> index, cross-source only
    out: list[dict] = []
    merged = 0

    for c in sorted(companies, key=_tier):  # authoritative records first
        dom = (c.get("domain") or "").strip().lower()
        nname = normalize_name(c.get("name", ""))
        idx = None
        if dom and dom in by_domain:
            idx = by_domain[dom]
        elif nname and nname in by_xname and out[by_xname[nname]].get("source") != c.get("source"):
            idx = by_xname[nname]

        if idx is not None:
            out[idx] = _merge(out[idx], c)
            merged += 1
            # refresh indexes to point at merged record
            if dom:
                by_domain[dom] = idx
            if nname:
                by_xname[nname] = idx
            continue

        pos = len(out)
        out.append(c)
        if dom:
            by_domain[dom] = pos
        if nname:
            by_xname[nname] = pos

    return out, merged

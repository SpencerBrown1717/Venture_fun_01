"""Derive normalized `source_records` (provenance) from a Company.

Every downstream label (tier, financing stage, evidence, badges) is computed
from these records, so the dashboard can always answer "why is this company in
the database?" with concrete, linkable sources.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse


def domain_of(company) -> str:
    url = company.website or (company.raw or {}).get("website") or ""
    if not url:
        return ""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    host = urlparse(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def build_source_records(company) -> list[dict]:
    raw = company.raw or {}
    seen_at = company.discovered_date or ""
    records: list[dict] = []

    # Preserve any records a source attached directly.
    for r in raw.get("source_records", []) or []:
        records.append(r)

    cik = str(raw.get("cik") or "").strip()
    if cik:
        records.append({
            "source_type": "sec_form_d",
            "source_name": "SEC EDGAR Form D",
            "source_url": raw.get("filing_url") or raw.get("edgar_url") or "",
            "observed_at": company.formation_date or seen_at,
            "confidence": 0.95,
            "notes": f"CIK {cik}",
        })

    file_no = str(raw.get("file_number") or "").strip()
    if file_no:
        records.append({
            "source_type": "state_incorporation",
            "source_name": "Delaware registry",
            "source_url": "",
            "observed_at": company.formation_date or seen_at,
            "confidence": 0.9,
            "notes": f"File #{file_no}",
        })

    accel = raw.get("accelerator")
    if accel:
        records.append({
            "source_type": "accelerator",
            "source_name": accel,
            "source_url": raw.get("accelerator_url") or "",
            "observed_at": raw.get("batch") or seen_at,
            "confidence": 0.85,
            "notes": (f"{raw.get('batch')} batch" if raw.get("batch") else "accelerator-backed"),
        })

    if company.website_verified and company.website:
        records.append({
            "source_type": "website",
            "source_name": "Company website",
            "source_url": company.website,
            "observed_at": seen_at,
            "confidence": 0.8,
            "notes": "live site verified",
        })

    if raw.get("is_hiring"):
        records.append({
            "source_type": "job_posting",
            "source_name": raw.get("jobs_source") or "Careers page",
            "source_url": raw.get("jobs_url") or company.website or "",
            "observed_at": seen_at,
            "confidence": 0.6,
            "notes": "actively hiring",
        })

    if any((f.get("source") or "").startswith(("sec_filing", "accelerator", "website")) for f in (company.founders or [])):
        records.append({
            "source_type": "founder_profile",
            "source_name": "Founder identity",
            "source_url": "",
            "observed_at": seen_at,
            "confidence": 0.7,
            "notes": f"{len(company.founders)} named",
        })

    if raw.get("launch_url"):
        records.append({
            "source_type": "product_launch",
            "source_name": raw.get("launch_source") or "Product launch",
            "source_url": raw.get("launch_url"),
            "observed_at": raw.get("launched_at") or seen_at,
            "confidence": 0.65,
        })

    return records

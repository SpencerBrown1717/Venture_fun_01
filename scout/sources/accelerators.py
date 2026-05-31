"""Accelerator source — real, open-source pre-Form-D companies.

Backed by the **YC OSS open dataset** (https://github.com/yc-oss/api), a public
mirror of Y Combinator's company directory. YC companies are the canonical
SAFE-stage / pre-Form-D companies (YC invented the SAFE), so this is exactly the
early layer the Form D feed misses.

Every record is real and links to its authoritative YC company page. We cache a
filtered snapshot to a fixture so CI / GitHub Pages never depend on a live fetch.
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path
from typing import Iterator

from ..models import Company
from .base import Source

DATASET_URL = "https://yc-oss.github.io/api/companies/all.json"
FIXTURE = Path(__file__).resolve().parent.parent / "data" / "fixtures" / "yc_ai_companies.json"

# Recent batches only — we want *new* companies, not the whole 15-year archive.
RECENT_BATCHES = {
    "Winter 2024", "Spring 2024", "Summer 2024", "Fall 2024",
    "Winter 2025", "Spring 2025", "Summer 2025", "Fall 2025",
    "X25", "W25", "S25", "F24", "S24", "W24",
}

# Map a YC batch to a representative ISO date (batch start) for month bucketing.
_BATCH_MONTH = {"Winter": "01", "Spring": "04", "Summer": "06", "Fall": "09"}

AI_KEYWORDS = (
    "ai", "a.i", "artificial intelligence", "machine learning", "ml", "llm",
    "agent", "agents", "agentic", "robot", "robotics", "autonomy", "autonomous",
    "computer vision", "neural", "deep learning", "generative", "copilot",
    "foundation model", "self-driving", "perception", "automation", "synthetic data",
)


def _batch_date(batch: str) -> str | None:
    parts = (batch or "").split()
    if len(parts) == 2 and parts[0] in _BATCH_MONTH and parts[1].isdigit():
        return f"{parts[1]}-{_BATCH_MONTH[parts[0]]}-01"
    return None


def _is_ai(rec: dict) -> bool:
    hay = " ".join([
        rec.get("one_liner", "") or "",
        rec.get("long_description", "") or "",
        " ".join(rec.get("tags", []) or []),
        " ".join(rec.get("industries", []) or []),
        rec.get("subindustry", "") or "",
    ]).lower()
    return any(f" {k} " in f" {hay} " or k in (rec.get("tags") or []) for k in AI_KEYWORDS)


class AcceleratorSource(Source):
    name = "accelerators"

    def __init__(self, *, refresh: bool = False, batches: set[str] | None = None,
                 user_agent: str = "venture-scout/1.0", **_: object) -> None:
        self.refresh = refresh
        self.batches = batches or RECENT_BATCHES
        self.user_agent = user_agent

    def _load_dataset(self) -> list[dict]:
        if FIXTURE.exists() and not self.refresh:
            try:
                return json.loads(FIXTURE.read_text())
            except (json.JSONDecodeError, OSError):
                pass
        # Live fetch + cache a filtered snapshot (recent AI companies only).
        req = urllib.request.Request(DATASET_URL, headers={"User-Agent": self.user_agent})
        with urllib.request.urlopen(req, timeout=40) as resp:
            allc = json.loads(resp.read().decode("utf-8", "replace"))
        filtered = [c for c in allc if c.get("batch") in self.batches and _is_ai(c)]
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(filtered, indent=2))
        return filtered

    def fetch(self, limit: int = 100) -> Iterator[Company]:
        data = self._load_dataset()
        # Newest batches first, then well-known "top" companies.
        data.sort(key=lambda c: (_batch_date(c.get("batch", "")) or "", int(c.get("top_company") or 0)), reverse=True)
        count = 0
        for rec in data:
            if count >= limit:
                break
            if rec.get("batch") not in self.batches or not _is_ai(rec):
                continue
            name = rec.get("name")
            if not name:
                continue
            website = rec.get("website") or None
            raw = {
                "accelerator": "Y Combinator",
                "accelerator_url": rec.get("url") or "",
                "batch": rec.get("batch"),
                "website": website,
                "is_hiring": bool(rec.get("isHiring")),
                "jobs_source": "YC Work at a Startup" if rec.get("isHiring") else "",
                "jobs_url": (rec.get("url") + "/jobs") if (rec.get("isHiring") and rec.get("url")) else "",
                "top_company": bool(rec.get("top_company")),
                "team_size": rec.get("team_size"),
                "yc_tags": rec.get("tags") or [],
                "yc_industries": rec.get("industries") or [],
                "status": rec.get("status"),
            }
            yield Company(
                name=name,
                source="accelerators",
                source_id=rec.get("slug") or str(rec.get("id") or name),
                jurisdiction=", ".join(rec.get("regions", [])[:1]) or (rec.get("all_locations") or "").split(";")[0].strip(),
                formation_date=_batch_date(rec.get("batch", "")),
                website=website,
                description=rec.get("one_liner") or rec.get("long_description", "")[:240],
                raw=raw,
            )
            count += 1

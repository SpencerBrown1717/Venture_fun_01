"""Build the bundled sample dataset from live Delaware filing records.

`gen-sample` scrapes the Delaware Division of Corporations ICIS portal for
recently incorporated entities (default: formed within the last 30 days) and
writes them to scout/data/sample_companies.json for offline/demo use.
"""

from __future__ import annotations

import json
from pathlib import Path

DATA_FILE = Path(__file__).resolve().parent / "data" / "sample_companies.json"


def harvest(
    *,
    max_age_days: int = 30,
    limit: int = 120,
    keywords: list[str] | None = None,
) -> list[dict]:
    from .sources.delaware import DelawareSource

    source = DelawareSource(max_age_days=max_age_days, keywords=keywords)
    records: list[dict] = []
    for company in source.fetch(limit=limit):
        records.append({
            "name": company.name,
            "source": company.source,
            "source_id": company.source_id,
            "jurisdiction": company.jurisdiction,
            "formation_date": company.formation_date,
            "description": company.description,
            "raw": company.raw,
        })
    records.sort(key=lambda r: r.get("formation_date") or "", reverse=True)
    return records


def write(
    path: Path | str | None = None,
    *,
    max_age_days: int = 30,
    limit: int = 120,
    keywords: list[str] | None = None,
) -> Path:
    out = Path(path) if path else DATA_FILE
    out.parent.mkdir(parents=True, exist_ok=True)
    records = harvest(max_age_days=max_age_days, limit=limit, keywords=keywords)
    if not records:
        raise RuntimeError(
            "Delaware harvest returned 0 entities within the formation window. "
            "Try --max-age-days 90 or run again later."
        )
    out.write_text(json.dumps(records, indent=2))
    return out

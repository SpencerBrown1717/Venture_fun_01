"""Export the database into a static JSON the dashboard can consume.

The dashboard is a static GitHub Pages site, so all server-side work (grouping,
aggregation, trend detection) is precomputed here into a single `data.json`.
This keeps the front-end dependency-free and instantly deployable.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from .db import Database


def _trends(companies: list[dict]) -> dict:
    """Stretch goal 6: lightweight trend detection over discoveries.

    Computes month-over-month AI discovery momentum, category and geographic
    distributions, and which categories are accelerating vs. cooling.
    """
    ai = [c for c in companies if c.get("is_ai")]

    by_month: dict[str, int] = defaultdict(int)
    cat_by_month: dict[str, Counter] = defaultdict(Counter)
    for c in ai:
        m = c.get("month", "unknown")
        by_month[m] += 1
        if c.get("ai_category"):
            cat_by_month[m][c["ai_category"]] += 1

    months = sorted(m for m in by_month if m != "unknown")

    # Category momentum: compare last month vs. the prior month.
    accelerating: list[dict] = []
    cooling: list[dict] = []
    if len(months) >= 2:
        last, prev = months[-1], months[-2]
        cats = set(cat_by_month[last]) | set(cat_by_month[prev])
        for cat in cats:
            now, before = cat_by_month[last][cat], cat_by_month[prev][cat]
            delta = now - before
            row = {"category": cat, "current": now, "previous": before, "delta": delta}
            if delta > 0:
                accelerating.append(row)
            elif delta < 0:
                cooling.append(row)
        accelerating.sort(key=lambda r: r["delta"], reverse=True)
        cooling.sort(key=lambda r: r["delta"])

    geo = Counter(c.get("jurisdiction") or "Unknown" for c in ai)
    categories = Counter(c.get("ai_category") for c in ai if c.get("ai_category"))
    verdicts = Counter(
        (c.get("recommendation") or {}).get("verdict")
        for c in ai
        if c.get("recommendation")
    )

    return {
        "ai_by_month": [{"month": m, "count": by_month[m]} for m in months],
        "categories": [{"category": k, "count": v} for k, v in categories.most_common()],
        "geography": [{"jurisdiction": k, "count": v} for k, v in geo.most_common(10)],
        "accelerating": accelerating[:5],
        "cooling": cooling[:5],
        "verdicts": [{"verdict": k, "count": v} for k, v in verdicts.most_common() if k],
    }


def _leaderboard(companies: list[dict], n: int = 12) -> list[dict]:
    """Top AI opportunities by overall score (stretch goal 4/8 surfacing)."""
    scored = [c for c in companies if c.get("is_ai") and c.get("scores")]
    scored.sort(key=lambda c: c["scores"].get("overall", 0), reverse=True)
    return [
        {
            "id": c["id"],
            "name": c["name"],
            "ai_category": c.get("ai_category"),
            "overall": c["scores"].get("overall"),
            "confidence": c["scores"].get("confidence"),
            "verdict": (c.get("recommendation") or {}).get("verdict"),
        }
        for c in scored[:n]
    ]


def export(db: Database, out_path: str | Path = "dashboard/data.json") -> dict:
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    companies = [c.to_dict() for c in db.all()]
    stats = db.stats()

    months = sorted({c["month"] for c in companies}, reverse=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "stats": {
            **stats,
            "months": len(months),
            "sources": sorted({c["source"] for c in companies}),
        },
        "months": months,
        "trends": _trends(companies),
        "leaderboard": _leaderboard(companies),
        "companies": companies,
    }

    out.write_text(json.dumps(payload, indent=2, default=str))
    return {"path": str(out), "count": len(companies), "months": len(months)}

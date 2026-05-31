"""Build & grow the dataset from real Delaware incorporation records.

`gen-sample` pulls companies *incorporated in Delaware* that filed a Form D
(operating companies, pooled funds dropped) from SEC EDGAR, enriches each with
its real officers / stage / capital, and writes them to
`scout/data/sample_companies.json`.

It is designed to **scale to hundreds** and **grow organically**: each run
merges newly discovered firms into the existing file (union by stable key), so
as new C-corps form month over month the dataset fills up and never loses past
discoveries. Form D detail fetches are parallelized to keep large runs fast.
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

DATA_FILE = Path(__file__).resolve().parent / "data" / "sample_companies.json"

# When no explicit window is given, cover the current calendar year so the feed
# fills up month over month.
DEFAULT_SINCE = f"{date.today().year}-01-01"

# OR'd AI/frontier-tech terms to surface relevant newly formed DE entities first.
AI_QUERY = (
    '"artificial intelligence" OR "machine learning" OR "generative AI" '
    'OR robotics OR "computer vision" OR "neural network" OR "large language model" '
    'OR autonomous OR "deep learning" OR "AI agents" OR "foundation model"'
)


def _to_record(company) -> dict:
    return {
        "name": company.name,
        "source": company.source,
        "source_id": company.source_id,
        "jurisdiction": company.jurisdiction,
        "formation_date": company.formation_date,
        "description": company.description,
        "raw": company.raw,
    }


def _record_key(rec: dict) -> str:
    raw = rec.get("raw") or {}
    return str(raw.get("cik") or rec.get("source_id") or rec.get("name", "")).lower()


def _enrich(rec: dict) -> dict | None:
    """Attach real Form D details. Returns None on hard failure (kept un-enriched
    by caller), annotates `raw['is_fund']` so pooled vehicles can be dropped."""
    from .edgar_detail import fetch_form_d_detail

    raw = rec.get("raw") or {}
    detail = fetch_form_d_detail(
        str(raw.get("cik") or ""),
        str(raw.get("accession") or ""),
        rec.get("name", ""),
    )
    if not detail:
        return rec

    rec["founders"] = detail["related_persons"]
    rec["stage"] = detail["stage"]
    raw.update({
        "industry_group": detail["industry_group"],
        "is_fund": detail["is_fund"],
        "offering_amount": detail["offering_amount"],
        "amount_sold": detail["amount_sold"],
        "revenue_range": detail["revenue_range"],
        "filing_url": detail["filing_url"],
        "stage": detail["stage"],
    })
    rec["raw"] = raw
    raised = detail["amount_sold"] or detail["offering_amount"]
    if raised:
        rec["description"] = (
            f"{rec.get('description', '').rstrip('.')}. "
            f"Form D reports ${raised:,} {'raised' if detail['amount_sold'] else 'offering'} "
            f"({detail['stage']})."
        )
    return rec


def _month_windows(since: str) -> list[tuple[str, str]]:
    """[(start_iso, end_iso), …] one per calendar month from `since` to today."""
    try:
        start = date.fromisoformat(since)
    except ValueError:
        start = date(date.today().year, 1, 1)
    today = date.today()
    windows: list[tuple[str, str]] = []
    y, m = start.year, start.month
    while (y < today.year) or (y == today.year and m <= today.month):
        first = date(y, m, 1)
        nm_y, nm_m = (y + 1, 1) if m == 12 else (y, m + 1)
        last = min(date(nm_y, nm_m, 1), today)
        windows.append((first.isoformat(), last.isoformat()))
        y, m = nm_y, nm_m
    return windows


def harvest(*, since: str = DEFAULT_SINCE, limit: int = 300, query: str = "",
            include_funds: bool = False, workers: int = 4,
            per_month_cap: int = 70, general_fill: bool = False) -> list[dict]:
    """Pull real, *operating* DE-incorporated firms from EDGAR across a window.

    EDGAR returns newest filings first, and recent months have thousands of DE
    Form D filings — so to cover the whole year we harvest **month by month**,
    keeping up to `per_month_cap` operating companies from each month. Pooled
    investment funds / SPVs are dropped. Enrichment is rate-limited (see
    edgar_detail) to respect SEC's fair-access policy.

    By default we use an AI/frontier-tech full-text query, which keeps the feed
    relevant (this is an *AI* incorporation scout) and keeps request volume low.
    Pass `general_fill=True` to also sweep all sectors for raw volume.
    """
    from .sources.delaware import DelawareSource

    def discover(src_query: str, start: str, end: str, cap: int) -> list[dict]:
        out, seen = [], set()
        if cap <= 0:
            return out
        source = DelawareSource(since=start, until=end, query=src_query)
        for company in source.fetch(limit=cap):
            key = str((company.raw or {}).get("cik") or company.source_id or company.name).lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(_to_record(company))
        return out

    all_kept: list[dict] = []
    seen_global: set[str] = set()

    # Newest month first so the per-run `limit` keeps the most recent firms.
    for (start, end) in reversed(_month_windows(since)):
        # Per month: AI-biased candidates first, then general fill for volume.
        pool = per_month_cap * 4
        cands: list[dict] = []
        cseen: set[str] = set()
        if query:
            passes = [(query, pool)]
        elif general_fill:
            passes = [(AI_QUERY, pool // 2), ("", pool)]
        else:
            passes = [(AI_QUERY, pool)]
        for src_query, cap in passes:
            for rec in discover(src_query, start, end, cap):
                k = _record_key(rec)
                if k in cseen:
                    continue
                cseen.add(k)
                cands.append(rec)

        kept_month: list[dict] = []
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futures = {ex.submit(_enrich, rec): rec for rec in cands}
            for fut in as_completed(futures):
                try:
                    rec = fut.result()
                except Exception:
                    rec = futures[fut]
                if not rec:
                    continue
                raw = rec.get("raw") or {}
                # Require successful enrichment so we never keep undetected funds.
                if not raw.get("industry_group"):
                    continue
                if not include_funds and raw.get("is_fund"):
                    continue
                kept_month.append(rec)

        kept_month.sort(key=lambda r: r.get("formation_date") or "", reverse=True)
        for rec in kept_month[:per_month_cap]:
            k = _record_key(rec)
            if k in seen_global:
                continue
            seen_global.add(k)
            all_kept.append(rec)
        print(f"[gen-sample] {start[:7]}: kept {min(len(kept_month), per_month_cap)} operating companies")
        if len(all_kept) >= limit:
            break

    all_kept.sort(key=lambda r: r.get("formation_date") or "", reverse=True)
    return all_kept[:limit]


def write(
    path: Path | str | None = None,
    *,
    since: str = DEFAULT_SINCE,
    limit: int = 250,
    query: str = "",
    merge: bool = True,
    general_fill: bool = False,
) -> Path:
    out = Path(path) if path else DATA_FILE
    out.parent.mkdir(parents=True, exist_ok=True)

    fresh = harvest(since=since, limit=limit, query=query, general_fill=general_fill)
    if not fresh and not (merge and out.exists()):
        raise RuntimeError(
            "Delaware (EDGAR) harvest returned 0 entities. "
            "Try an earlier --since date or run again later."
        )

    # Merge with existing dataset so the corpus grows organically over time.
    combined: dict[str, dict] = {}
    if merge and out.exists():
        try:
            for rec in json.loads(out.read_text()):
                combined[_record_key(rec)] = rec
        except (json.JSONDecodeError, OSError):
            pass
    for rec in fresh:
        combined[_record_key(rec)] = rec  # fresh enrichment wins

    records = sorted(combined.values(), key=lambda r: r.get("formation_date") or "", reverse=True)
    out.write_text(json.dumps(records, indent=2))
    print(f"[gen-sample] wrote {len(records)} companies ({len(fresh)} from this run).")
    return out

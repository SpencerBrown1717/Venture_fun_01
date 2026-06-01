"""VC deals export → investor-centric dashboard JSON.

Reads a VC deals export (one row per investor-per-deal) and aggregates
it by *investor firm* — the "Investors" tab: who is backing the recently-funded
AI startups, and which portfolio firms each has invested in.

This is the complement to the company-centric "Startups to Watch" feed: same
underlying deals, pivoted around the investors instead of the firms.

Dependency-free — reuses the OOXML reader from ``scout.watch``.

    python -m scout.vc_deals          # writes dashboard/vc_deals.json
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path

from scout.watch import _excel_date, _is_ai, _num, _read_rows, _split

DEFAULT_XLSX = Path(__file__).parent / "data" / "vc_deals.xlsx"
DEFAULT_OUT = Path(__file__).parent.parent / "dashboard" / "vc_deals.json"


def _clean(value) -> str | None:
    s = str(value).strip() if value is not None else ""
    return s or None


def parse(xlsx_path: Path = DEFAULT_XLSX) -> dict:
    """Aggregate the deals export into one record per investor firm."""
    rows = _read_rows(xlsx_path)
    if not rows:
        return {"investors": [], "stats": {}}

    header = [(h or "").strip().upper() for h in rows[0]]

    def col(name: str) -> int:
        for i, h in enumerate(header):
            if h == name:
                return i
        for i, h in enumerate(header):
            if h.startswith(name):
                return i
        return -1

    c_deal = col("DEAL ID")
    c_company = col("PORTFOLIO COMPANY")
    c_inv = col("INVESTORS")
    c_inv_t = col("INVESTOR TYPE")
    c_date = col("DEAL DATE")
    c_stage = col("STAGE")
    c_ind = col("PRIMARY INDUSTRY")
    c_sub = col("SUB-INDUSTRIES")
    c_vert = col("INDUSTRY VERTICALS")
    c_size_usd = col("DEAL SIZE (USD")
    c_size = col("DEAL SIZE")
    c_inv_city = col("INVESTOR CITY")
    c_inv_state = col("INVESTOR STATE")
    c_inv_country = col("INVESTOR COUNTRY")

    def get(row: list, i: int):
        return row[i] if 0 <= i < len(row) else None

    investors: dict[str, dict] = {}
    deal_ids: set[str] = set()
    companies: set[str] = set()
    deal_size: dict[str, float] = {}

    for row in rows[1:]:
        firm = _clean(get(row, c_inv))
        company = _clean(get(row, c_company))
        deal_id = _clean(get(row, c_deal))
        if not firm or not company:
            continue
        deal_ids.add(deal_id or company)
        companies.add(company)

        size = _num(get(row, c_size_usd)) if c_size_usd >= 0 else None
        if size is None:
            size = _num(get(row, c_size))
        if deal_id:
            deal_size[deal_id] = size or 0.0

        comp = {
            "name": company,
            "stage": _clean(get(row, c_stage)),
            "size_usd_mn": size,
            "date": _excel_date(get(row, c_date)),
            "is_ai": _is_ai({
                "company": company,
                "primary_industry": _clean(get(row, c_ind)),
                "sub_industries": _split(get(row, c_sub)),
                "verticals": _split(get(row, c_vert)),
            }),
        }

        inv = investors.get(firm)
        if inv is None:
            inv = investors[firm] = {
                "name": firm,
                "type": _clean(get(row, c_inv_t)),
                "city": _clean(get(row, c_inv_city)),
                "state": _clean(get(row, c_inv_state)),
                "country": _clean(get(row, c_inv_country)),
                "companies": [],
                "_seen": set(),
            }
        if company not in inv["_seen"]:
            inv["_seen"].add(company)
            inv["companies"].append(comp)
        # Backfill location if the first row was missing it.
        for k, c in (("city", c_inv_city), ("state", c_inv_state), ("country", c_inv_country)):
            if not inv[k]:
                inv[k] = _clean(get(row, c))

    out = []
    for inv in investors.values():
        comps = inv["companies"]
        out.append({
            "name": inv["name"],
            "type": inv["type"],
            "city": inv["city"],
            "state": inv["state"],
            "country": inv["country"],
            "deals": len(comps),
            "ai_deals": sum(1 for c in comps if c["is_ai"]),
            "total_usd_mn": round(sum(c["size_usd_mn"] or 0 for c in comps), 2),
            "companies": sorted(comps, key=lambda c: (c["date"] or "", c["size_usd_mn"] or 0), reverse=True),
        })
    # Most active first, then most capital deployed-alongside, then name.
    out.sort(key=lambda x: (x["deals"], x["total_usd_mn"], x["name"].lower()), reverse=True)

    stats = {
        "investors": len(out),
        "firms": len(companies),
        "deals": len(deal_ids),
        "total_capital_mn": round(sum(deal_size.values()), 1),
        "ai_firms": len({c for inv in out for c in [d["name"] for d in inv["companies"] if d["is_ai"]]}),
    }
    return {"investors": out, "stats": stats}


def export(xlsx_path: Path = DEFAULT_XLSX, out_path: Path = DEFAULT_OUT) -> dict:
    data = parse(xlsx_path)
    payload = {
        "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": "VC export",
        "stats": data["stats"],
        "investors": data["investors"],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2))
    return payload


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Convert a VC deals export into dashboard/vc_deals.json (by investor)")
    ap.add_argument("--xlsx", type=Path, default=DEFAULT_XLSX)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()
    p = export(args.xlsx, args.out)
    s = p["stats"]
    print(f"Wrote {args.out} — {s['investors']} investors across {s['firms']} firms, "
          f"{s['deals']} deals, ${s['total_capital_mn']}mn total.")

"""Preqin deals export → dashboard JSON.

Reads a Preqin "deals export" .xlsx (one row per investor-per-deal) and
aggregates it into one record per deal/company — the "Startups to Watch" feed:
recently-closed, investor-backed (mostly seed-stage AI) financings.

This is a *confirmed financing* source, distinct from the SEC EDGAR Form D feed
and the inferred Pre-Form-D Radar. The provenance is preserved: every record
carries its source deal id, the closing date, the round size, and the full
investor syndicate exactly as reported by Preqin.

Dependency-free: parses the OOXML zip/XML directly (no openpyxl required).

    python -m scout preqin --export
"""

from __future__ import annotations

import json
import re
import zipfile
from datetime import date, timedelta
from pathlib import Path
from xml.etree import ElementTree as ET

_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_EXCEL_EPOCH = date(1899, 12, 30)  # Excel's day 0 (accounts for the 1900 leap bug)

DEFAULT_XLSX = Path(__file__).parent / "data" / "preqin_deals.xlsx"
DEFAULT_OUT = Path(__file__).parent.parent / "dashboard" / "preqin.json"


def _col_index(ref: str) -> int:
    """'B7' -> 1 (zero-based column index)."""
    letters = re.match(r"[A-Z]+", ref).group(0)
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _read_rows(xlsx_path: Path) -> list[list[str | None]]:
    """Return the first worksheet as a list of row-lists of cell strings."""
    z = zipfile.ZipFile(xlsx_path)

    shared: list[str] = []
    try:
        sst = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in sst.findall(f"{_NS}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{_NS}t")))
    except KeyError:
        pass

    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    rows: list[list[str | None]] = []
    for row in sheet.iter(f"{_NS}row"):
        cells: dict[int, str | None] = {}
        for c in row.findall(f"{_NS}c"):
            idx = _col_index(c.get("r"))
            ctype = c.get("t")
            v = c.find(f"{_NS}v")
            inline = c.find(f"{_NS}is")
            if ctype == "s" and v is not None:
                val = shared[int(v.text)]
            elif inline is not None:
                val = "".join(t.text or "" for t in inline.iter(f"{_NS}t"))
            elif v is not None:
                val = v.text
            else:
                val = None
            cells[idx] = val
        width = (max(cells) + 1) if cells else 0
        rows.append([cells.get(i) for i in range(width)])
    return rows


def _excel_date(serial: str | None) -> str | None:
    try:
        return (_EXCEL_EPOCH + timedelta(days=int(float(serial)))).isoformat()
    except (TypeError, ValueError):
        return None


def _split(value: str | None) -> list[str]:
    if not value:
        return []
    return [p.strip() for p in str(value).split(",") if p.strip()]


def _num(value: str | None) -> float | None:
    try:
        return round(float(value), 3)
    except (TypeError, ValueError):
        return None


_AI_TERMS = (
    "artificial intelligence", "machine learning", "deep learning", "generative",
    "neural", "computer vision", "nlp", "natural language", "llm", "large language",
    "autonomous", "robotic", "agent", "data science", "predictive", " ai ", "ai/",
    "/ai", "ai-", "-ai", "aiops", "mlops",
)


def _is_ai(deal: dict) -> bool:
    hay = " ".join([
        deal.get("company") or "",
        deal.get("primary_industry") or "",
        *(deal.get("sub_industries") or []),
        *(deal.get("verticals") or []),
    ]).lower()
    hay = f" {hay} "
    return any(term in hay for term in _AI_TERMS)


def parse(xlsx_path: Path = DEFAULT_XLSX) -> list[dict]:
    """Aggregate the deals export into one record per deal."""
    rows = _read_rows(xlsx_path)
    if not rows:
        return []

    header = [(h or "").strip().upper() for h in rows[0]]

    def col(name: str) -> int:
        # Prefer an exact header match (so "PORTFOLIO COMPANY" doesn't bind to
        # "PORTFOLIO COMPANY ID"), then fall back to a prefix match.
        for i, h in enumerate(header):
            if h == name:
                return i
        for i, h in enumerate(header):
            if h.startswith(name):
                return i
        return -1

    c_deal = col("DEAL ID")
    c_name = col("PORTFOLIO COMPANY")
    c_inv = col("INVESTORS")
    c_inv_t = col("INVESTOR TYPE")
    c_date = col("DEAL DATE")
    c_status = col("DEAL STATUS")
    c_stage = col("STAGE")
    c_ind = col("PRIMARY INDUSTRY")
    c_sub = col("SUB-INDUSTRIES")
    c_vert = col("INDUSTRY VERTICALS")
    c_curr = col("DEAL CURRENCY")
    c_size = col("DEAL SIZE")

    def get(row: list, i: int) -> str | None:
        return row[i] if 0 <= i < len(row) else None

    deals: dict[str, dict] = {}
    for row in rows[1:]:
        deal_id = get(row, c_deal)
        name = get(row, c_name)
        if not deal_id or not name:
            continue
        d = deals.get(deal_id)
        if d is None:
            d = deals[deal_id] = {
                "deal_id": deal_id,
                "company": str(name).strip(),
                "stage": (get(row, c_stage) or "").strip() or None,
                "deal_status": (get(row, c_status) or "").strip() or None,
                "deal_date": _excel_date(get(row, c_date)),
                "deal_size_usd_mn": _num(get(row, c_size)),
                "currency": (get(row, c_curr) or "").strip() or None,
                "city": None,  # not present in the deals export
                "primary_industry": (get(row, c_ind) or "").strip() or None,
                "sub_industries": _split(get(row, c_sub)),
                "verticals": _split(get(row, c_vert)),
                "lead_partners": [],  # not flagged in this export
                "investors": [],
            }
        inv = (get(row, c_inv) or "").strip()
        if inv and not any(x["name"] == inv for x in d["investors"]):
            d["investors"].append({"name": inv, "type": (get(row, c_inv_t) or "").strip() or None})

    for d in deals.values():
        d["is_ai"] = _is_ai(d)

    out = list(deals.values())
    # Newest, then largest round, then most-syndicated.
    out.sort(key=lambda d: (d["deal_date"] or "", d["deal_size_usd_mn"] or 0, len(d["investors"])), reverse=True)
    return out


def export(xlsx_path: Path = DEFAULT_XLSX, out_path: Path = DEFAULT_OUT) -> dict:
    deals = parse(xlsx_path)
    total_capital = round(sum(d["deal_size_usd_mn"] or 0 for d in deals), 1)
    investors: dict[str, int] = {}
    for d in deals:
        for inv in d["investors"]:
            investors[inv["name"]] = investors.get(inv["name"], 0) + 1
    top_investors = sorted(investors.items(), key=lambda kv: kv[1], reverse=True)[:8]

    payload = {
        "generated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": "Preqin deals export · 2026-03-25",
        "stats": {
            "deals": len(deals),
            "ai_deals": sum(1 for d in deals if d["is_ai"]),
            "total_capital_mn": total_capital,
            "currency": deals[0]["currency"] if deals else "USD",
            "investors": len(investors),
            "top_investors": [{"name": n, "deals": c} for n, c in top_investors],
        },
        "deals": deals,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2))
    return payload


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Convert a Preqin deals export to dashboard/preqin.json")
    ap.add_argument("--xlsx", type=Path, default=DEFAULT_XLSX)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()
    p = export(args.xlsx, args.out)
    print(f"Wrote {args.out} — {p['stats']['deals']} deals, "
          f"${p['stats']['total_capital_mn']}mn total across "
          f"{len(p['stats']['top_investors'])} top investors.")

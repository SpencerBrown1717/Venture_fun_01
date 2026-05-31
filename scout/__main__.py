"""Command-line interface for the AI Incorporation Scout.

Examples
--------
    # Generate the bundled sample dataset
    python -m scout gen-sample

    # Discover + classify from the offline sample, then export the dashboard
    python -m scout run --source sample --export

    # Pull live newly-formed filers from SEC EDGAR (Form D), AI-biased query
    python -m scout run --source sec_edgar --query "artificial intelligence" --limit 50

    # Turn on the research agent + LLM (needs OPENAI_API_KEY)
    python -m scout run --source sample --research --llm --export

    # Re-export the dashboard data from the current database
    python -m scout export

    # Print database stats
    python -m scout stats
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .db import Database
from .export import export as export_dashboard
from .pipeline import Pipeline


def _cmd_gen_sample(args: argparse.Namespace) -> int:
    from .seed import write, DEFAULT_SINCE

    path = write(
        args.out,
        since=args.since or DEFAULT_SINCE,
        limit=args.limit,
        merge=not args.no_merge,
        general_fill=args.general_fill,
    )
    print(f"Wrote Delaware sample dataset -> {path}")
    return 0


def _cmd_run(args: argparse.Namespace) -> int:
    db = Database(args.db)
    pipeline = Pipeline(
        db=db,
        use_llm=args.llm,
        research=args.research,
        research_min_score=args.research_min_score,
        fetch_site=not args.no_fetch_site,
    )

    source_kwargs: dict = {}
    if args.source == "sec_edgar":
        source_kwargs = {
            "query": args.query,
            "days_back": args.days_back,
            "forms": args.forms,
        }
        if args.user_agent:
            source_kwargs["user_agent"] = args.user_agent
    elif args.source == "delaware":
        # EDGAR-backed DE incorporation feed: honor query/window like sec_edgar.
        source_kwargs = {
            "days_back": max(args.days_back, args.max_age_days),
            "query": args.query,
            "since": args.since,
        }
        if args.user_agent:
            source_kwargs["user_agent"] = args.user_agent
    elif args.source == "delaware_icis":
        source_kwargs = {"max_age_days": args.max_age_days}

    report = pipeline.run(args.source, limit=args.limit, **source_kwargs)
    print(report.summary())
    for err in report.errors[:10]:
        print(f"  ! {err}")

    # Pre-Form-D Radar: also ingest the accelerator (YC) source into the same DB.
    if getattr(args, "include_pre_form_d", False) and args.source != "accelerators":
        accel = pipeline.run("accelerators", limit=args.pre_form_d_limit)
        print(accel.summary())
        for err in accel.errors[:5]:
            print(f"  ! {err}")

    if args.export:
        info = export_dashboard(db, args.export_path)
        print(f"exported {info['count']} companies across {info['months']} months -> {info['path']}")

    print("db stats:", db.stats())
    db.close()
    return 0


def _cmd_export(args: argparse.Namespace) -> int:
    db = Database(args.db)
    info = export_dashboard(db, args.export_path)
    print(f"exported {info['count']} companies across {info['months']} months -> {info['path']}")
    db.close()
    return 0


def _cmd_stats(args: argparse.Namespace) -> int:
    db = Database(args.db)
    print(db.stats())
    db.close()
    return 0


def _cmd_verify_links(args: argparse.Namespace) -> int:
    """Check every website in the sample JSON (or DB) and report failures."""
    from .validate import verify_url

    if args.db:
        db = Database(args.db)
        rows = [(c.name, c.website) for c in db.all()]
        db.close()
    else:
        import json
        from .seed import DATA_FILE

        path = args.sample or DATA_FILE
        rows = [(r["name"], r.get("website")) for r in json.loads(path.read_text())]

    ok = bad = 0
    for name, url in rows:
        if not url:
            continue
        if verify_url(url):
            ok += 1
            if args.verbose:
                print(f"  OK  {url}")
        else:
            bad += 1
            print(f"  FAIL {name}: {url}")
    print(f"verified {ok + bad} links: {ok} ok, {bad} failed")
    return 1 if bad else 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="scout", description="AI Incorporation Scout Agent")
    p.add_argument("--db", default="scout.db", help="SQLite database path")
    sub = p.add_subparsers(dest="command", required=True)

    g = sub.add_parser("gen-sample", help="Harvest real DE incorporations (SEC EDGAR) into sample_companies.json")
    g.add_argument("--out", default=None, help="Output JSON path (default: scout/data/sample_companies.json)")
    g.add_argument("--since", default="", help="Earliest formation/filing date ISO (default: Jan 1 of current year)")
    g.add_argument("--max-age-days", type=int, default=30, dest="max_age_days",
                   help="(legacy) keep entities incorporated within this many days")
    g.add_argument("--limit", type=int, default=250, help="Max operating companies to keep per run (default: 250)")
    g.add_argument("--no-merge", action="store_true", help="Overwrite instead of merging with the existing dataset")
    g.add_argument("--general-fill", action="store_true", dest="general_fill",
                   help="Also sweep all sectors (not just AI) for raw volume — AI firms still flagged/highlighted")
    g.set_defaults(func=_cmd_gen_sample)

    r = sub.add_parser("run", help="Discover, classify, (research), and store")
    r.add_argument("--source", default="sample", help="Source connector name (sample, delaware, sec_edgar)")
    r.add_argument("--limit", type=int, default=200)
    r.add_argument("--max-age-days", type=int, default=30, dest="max_age_days",
                   help="[delaware] keep entities incorporated within N days")
    r.add_argument("--llm", action="store_true", help="Use LLM classifier/memos (needs OPENAI_API_KEY)")
    r.add_argument("--research", action="store_true", help="Run the full Venture Analyst Swarm (memo + founders + scoring + competitive + recommendation)")
    r.add_argument("--research-min-score", type=float, default=0.5, dest="research_min_score")
    r.add_argument("--no-fetch-site", action="store_true", help="Don't visit company websites during research")
    r.add_argument("--export", action="store_true", help="Export dashboard data after the run")
    r.add_argument("--export-path", default="dashboard/data.json")
    # sec_edgar options
    r.add_argument("--query", default="", help="[sec_edgar] full-text query bias")
    r.add_argument("--days-back", type=int, default=30, dest="days_back", help="[sec_edgar] lookback window")
    r.add_argument("--since", default="", help="[sec_edgar/delaware] explicit ISO start date (overrides --days-back)")
    r.add_argument("--forms", default="D", help="[sec_edgar] form types")
    r.add_argument("--user-agent", default="", help="[sec_edgar] required descriptive User-Agent")
    r.add_argument("--include-pre-form-d", action="store_true", dest="include_pre_form_d",
                   help="Also ingest the accelerator (YC) pre-Form-D source into the same dataset")
    r.add_argument("--pre-form-d-limit", type=int, default=120, dest="pre_form_d_limit",
                   help="Max accelerator companies to ingest with --include-pre-form-d")
    r.set_defaults(func=_cmd_run)

    d = sub.add_parser("discover", help="Ingest one source (alias of run, research off by default)")
    d.add_argument("--source", default="accelerators", help="Source connector name")
    d.add_argument("--limit", type=int, default=120)
    d.add_argument("--max-age-days", type=int, default=30, dest="max_age_days")
    d.add_argument("--llm", action="store_true")
    d.add_argument("--research", action="store_true")
    d.add_argument("--research-min-score", type=float, default=0.5, dest="research_min_score")
    d.add_argument("--no-fetch-site", action="store_true")
    d.add_argument("--export", action="store_true")
    d.add_argument("--export-path", default="dashboard/data.json")
    d.add_argument("--query", default="")
    d.add_argument("--days-back", type=int, default=30, dest="days_back")
    d.add_argument("--since", default="")
    d.add_argument("--forms", default="D")
    d.add_argument("--user-agent", default="")
    d.set_defaults(func=_cmd_run)

    e = sub.add_parser("export", help="Export dashboard data from the database")
    e.add_argument("--export-path", default="dashboard/data.json")
    e.set_defaults(func=_cmd_export)

    s = sub.add_parser("stats", help="Print database stats")
    s.set_defaults(func=_cmd_stats)

    v = sub.add_parser("verify-links", help="Verify all company website URLs resolve")
    v.add_argument("--sample", type=Path, default=None, help="Sample JSON path (default: scout/data/sample_companies.json)")
    v.add_argument("--db", default="", help="Verify URLs stored in this DB instead of sample JSON")
    v.add_argument("-v", "--verbose", action="store_true")
    v.set_defaults(func=_cmd_verify_links)

    q = sub.add_parser("preqin", help="Convert a Preqin deals export to dashboard/preqin.json (Startups to Watch)")
    q.add_argument("--xlsx", type=Path, default=None, help="Preqin deals .xlsx (default: scout/data/preqin_deals.xlsx)")
    q.add_argument("--out", type=Path, default=None, help="Output JSON (default: dashboard/preqin.json)")
    q.set_defaults(func=_cmd_preqin)

    return p


def _cmd_preqin(args: argparse.Namespace) -> int:
    from . import preqin

    kwargs = {}
    if args.xlsx:
        kwargs["xlsx_path"] = args.xlsx
    if args.out:
        kwargs["out_path"] = args.out
    payload = preqin.export(**kwargs)
    st = payload["stats"]
    print(f"Wrote dashboard/preqin.json — {st['deals']} deals "
          f"({st['ai_deals']} AI), ${st['total_capital_mn']}mn across {st['investors']} investors.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

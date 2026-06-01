# SCOUT — Pre-Form-D Venture Radar

> Finds AI-native companies *before* they show up in funding databases —
> separating **verified evidence** from **inference** at every step.

**Live dashboard:** https://spencerbrown1717.github.io/Venture_fun_01/dashboard/

An agentic pipeline ingests public company records (SEC EDGAR Form D, the open
YC dataset, and a VC deals export), classifies AI-relatedness, researches each
firm, scores the opportunity, and publishes a single static dashboard — no
backend, no build step. A client-side **Network** tab then turns your own
contacts into warm paths to those companies, their investors, and the partners
who can make the intro.

---

## Quick start

Python 3.10+. The core pipeline uses **only the standard library** — no install.

```bash
# Discover + classify + research from the bundled sample, then export
python -m scout run --source sample --research --export

# Open the dashboard
cd dashboard && python -m http.server 8000   # → http://localhost:8000
```

The committed JSON (`dashboard/data.json`, `watch.json`, `vc_deals.json`) means
the dashboard works instantly with no pipeline run.

---

## The dashboard

Eight tabs, grouped into **Discovery**, **Funding**, and **Access**:

| Tab | What it shows |
| --- | --- |
| **All Companies** | Full feed with natural-language search + filters (category, signal, source tier, evidence, opportunity, review status) |
| **Pre-Form-D Radar** | Probable SAFE-stage / pre-seed AI firms with no public Form D yet — labeled as inference |
| **Confirmed Form D** | SEC-verified filings, each linked to its EDGAR record |
| **Needs Review** | Local triage queue (Needs review / Track / Outreach / Pass), stored in `localStorage` |
| **Leaderboard** | Top AI companies by opportunity score, with trend, category, momentum, and geography charts |
| **Startups to Watch** | Recently *funded* AI startups from a VC deals export, with investor syndicates |
| **Investors** | The VC firms behind those deals — website/LinkedIn/X/email, lead partners, stage mix, and a portfolio table (click any card) |
| **⧉ Network** | Your contacts → warm paths into companies, investors, and partners (see below) |

Every company opens an **analysis drawer**: recommendation, evidence panel
("why this is here" + missing-data checklist), founders, a 6-dimension
opportunity score, competitive landscape, risks, and verification.

**Honesty-first:** evidence score (how much we *know*) is kept separate from
opportunity score (how *interesting* it looks). Founders/links are only shown
when they come from a verified source; guessed values are clearly flagged.

### Network — warm-intro engine (client-side)

Drop in a **Gmail (Google Contacts)** or **LinkedIn `Connections.csv`** export —
parsed entirely in your browser, contacts never leave the page — and SCOUT maps
your relationships onto the dataset:

- **Matching** — contacts → founders named in SEC filings + company domains
  (startup paths), and → investor firms + their lead partners (investor paths),
  with **super-connector** detection for people who bridge several targets.
- **Relationship graph** — a radial SVG of You → contacts → companies / investors
  / partners, with 6 filters (startup, investor, partner, company↔investor,
  verified-only, A/A+ access) and click-through node drawers.
- **Action layer** — investor warm-intro cards and super-connector cards with
  access score + grade, an **evidence audit** (signal/source chips, verified vs.
  inferred), and **copyable outreach drafts** (intro request / direct note / CRM).
- **Saved targets** — companies + investors you flag, persisted in `localStorage`.

Same honesty-first rule as the rest of the app: verified paths are kept distinct
from name-only inferences.

---

## Data commands

| Command | Description |
| --- | --- |
| `python -m scout run` | Discover → verify → classify → (research) → store |
| `python -m scout gen-sample` | Pull real DE-incorporated firms (EDGAR) into the sample JSON |
| `python -m scout export` | Re-export `dashboard/data.json` from the DB |
| `python -m scout watch` | VC deals export → `dashboard/watch.json` (Startups to Watch) |
| `python -m scout.vc_deals` | VC deals export → `dashboard/vc_deals.json` (Investors) |
| `python -m scout stats` | Print database stats |

Key `run` flags: `--source {sample,delaware,sec_edgar}`, `--research`, `--llm`,
`--include-pre-form-d`, `--query`, `--days-back`, `--export`.

**Optional LLM** (`pip install -r requirements.txt`, set `OPENAI_API_KEY`, add
`--llm`) upgrades classification and memos; it falls back to heuristics if absent.

---

## Deploy (GitHub Pages)

Pushing to `main` auto-deploys via `.github/workflows/deploy.yml` (build + publish
`dashboard/`). One-time: **Settings → Pages → Source = GitHub Actions**.

---

## Architecture

```
scout/
├── __main__.py        # CLI
├── pipeline.py        # agent orchestration
├── sources/           # SEC EDGAR, Delaware, sample connectors
├── classify/          # AI-relatedness (heuristic + optional LLM)
├── inference/         # source tier, financing stage, evidence score
├── research/          # website visit + investment memo
├── score.py · founders.py · competitive.py · recommend.py
├── watch.py           # VC deals → watch.json (by deal)
├── investor_directory.py · vc_deals.py   # VC deals → vc_deals.json (by investor)
└── db.py · export.py · models.py

dashboard/             # static, Pages-ready front-end
├── index.html · app.js · styles.css
└── data.json · watch.json · vc_deals.json   # precomputed, committed
```

Data flows DB → precomputed JSON → static dashboard. The pipeline is idempotent
(re-runs upsert), fail-soft (a bad record never kills a run), and dependency-free
at its core.

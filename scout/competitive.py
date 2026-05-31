"""Competitive Landscape Generator (stretch goal 5).

For each discovered company we produce:
  * category leaders (real, well-known incumbents in the subsector),
  * adjacent companies (peers discovered in our own dataset),
  * a short positioning read and a "white space" prompt.

Leaders come from a curated knowledge base so the output is grounded in real
companies rather than hallucinated. Adjacency is computed from the live dataset,
so the more the scout discovers, the richer the market map becomes.
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import Company

# Real, recognizable leaders per subsector (illustrative, not exhaustive).
LEADERS: dict[str, list[str]] = {
    "AI Infrastructure": ["OpenAI", "Anthropic", "Together AI", "Modal", "Fireworks AI", "CoreWeave"],
    "Developer Tools": ["GitHub Copilot", "Cursor", "Replit", "Codeium", "Sourcegraph"],
    "AI Agents": ["Cognition (Devin)", "Sierra", "Adept", "CrewAI", "LangChain"],
    "Computer Vision": ["Scale AI", "Roboflow", "Landing AI", "V7"],
    "NLP / Language": ["OpenAI", "Anthropic", "Cohere", "Mistral AI", "AI21 Labs"],
    "Robotics": ["Figure", "Physical Intelligence", "Skild AI", "Covariant"],
    "Healthcare AI": ["Abridge", "Ambience", "Hippocratic AI", "OpenEvidence"],
    "Fintech AI": ["Ramp", "Sardine", "Stripe Radar", "Hummingbird"],
    "Generative Media": ["Runway", "ElevenLabs", "Pika", "Synthesia", "Suno"],
    "Data / Analytics": ["Databricks", "Snowflake Cortex", "Hex", "Sigma"],
    "General AI": ["OpenAI", "Anthropic", "Google DeepMind", "Mistral AI"],
}

WHITE_SPACE: dict[str, str] = {
    "AI Infrastructure": "cost/latency at the inference layer and vertical-specific serving.",
    "Developer Tools": "agentic workflows beyond autocomplete and enterprise governance.",
    "AI Agents": "reliability, evaluation, and a defensible workflow wedge.",
    "Computer Vision": "proprietary data loops in underserved industrial verticals.",
    "NLP / Language": "domain ownership and data advantages vs. frontier-model commoditization.",
    "Robotics": "real-world reliability and a profitable beachhead deployment.",
    "Healthcare AI": "reimbursement pathways and clinical validation.",
    "Fintech AI": "regulatory-grade accuracy and incumbent data moats.",
    "Generative Media": "retention, rights/IP clarity, and creator distribution.",
    "Data / Analytics": "moving from dashboards to autonomous action.",
    "General AI": "a sharp ICP and a non-obvious wedge.",
}


@dataclass
class MarketAgent:
    """Builds competitive context. Call `index(companies)` once, then `analyze`."""

    def index(self, companies: list[Company]) -> "MarketAgent":
        self._by_cat: dict[str, list[str]] = {}
        for c in companies:
            if c.is_ai and c.ai_category:
                self._by_cat.setdefault(c.ai_category, []).append(c.name)
        return self

    def analyze(self, company: Company) -> Company:
        cat = company.ai_category or "General AI"
        leaders = LEADERS.get(cat, LEADERS["General AI"])
        adjacent = [n for n in getattr(self, "_by_cat", {}).get(cat, []) if n != company.name][:6]
        positioning = (
            f"Enters {cat} against incumbents like {', '.join(leaders[:3])}. "
            f"Key white space: {WHITE_SPACE.get(cat, WHITE_SPACE['General AI'])}"
        )
        company.competitive = {
            "category": cat,
            "leaders": leaders,
            "adjacent": adjacent,
            "white_space": WHITE_SPACE.get(cat, WHITE_SPACE["General AI"]),
            "positioning": positioning,
        }
        return company

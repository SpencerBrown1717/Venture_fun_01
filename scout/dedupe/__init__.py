"""Deduplication: merge the same company discovered across multiple sources.

The realistic duplicate is one startup appearing in both the accelerator feed
and (later) a Form D filing. We merge those into a single record, preserving all
source provenance and never silently dropping data.
"""

from __future__ import annotations

from .matcher import normalize_name, dedupe

__all__ = ["normalize_name", "dedupe"]

"""Additive, display-only enrichment for parser records.

This package deliberately stays outside ``parser.py`` and the parse worker RPC
registry.  Call :func:`enrich_record` explicitly when a consumer wants a richer
view while retaining the parser record as the authoritative value.
"""

from .coverage import evaluate_coverage
from .overlay import SAFE_PATHS, apply_candidates
from .pipeline import enrich_record
from .sampler_view_adapter import build_sampler_view_candidates

__all__ = [
    "SAFE_PATHS",
    "apply_candidates",
    "build_sampler_view_candidates",
    "enrich_record",
    "evaluate_coverage",
]

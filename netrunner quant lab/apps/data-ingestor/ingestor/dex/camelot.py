from __future__ import annotations

from .uniswap_v3 import DexCollector


class CamelotCollector(DexCollector):
    """Camelot uses the same API-backed persistence contract for the MVP.

    A dedicated Algebra/Camelot tick-walking adapter can replace this class later without changing
    API routes or stored provenance.
    """

from __future__ import annotations

from .uniswap_v3_adapter import UniswapV3ArbitrumDataAdapter


class CamelotArbitrumDataAdapter(UniswapV3ArbitrumDataAdapter):
    venue_id = "camelot-arbitrum"


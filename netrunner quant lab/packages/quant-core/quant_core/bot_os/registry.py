from __future__ import annotations

from typing import Any

from .bots import (
    ChaseLimitBot,
    CrossAssetAllocatorBot,
    DcaBot,
    FundingArbitrageBot,
    FuturesComboBot,
    FuturesDcaBot,
    FuturesGridBot,
    FuturesMartingaleBot,
    IcebergBot,
    PositionSnowballBot,
    RebalancerBot,
    ScaledOrderBot,
    SpotGridBot,
    TwapBot,
    VpPovBot,
)
from .models import BotType


BOT_REGISTRY = {
    "spot_grid": SpotGridBot,
    "futures_grid": FuturesGridBot,
    "dca": DcaBot,
    "futures_dca": FuturesDcaBot,
    "futures_martingale": FuturesMartingaleBot,
    "futures_combo": FuturesComboBot,
    "rebalancer": RebalancerBot,
    "funding_arbitrage": FundingArbitrageBot,
    "twap": TwapBot,
    "vp_pov": VpPovBot,
    "chase_limit": ChaseLimitBot,
    "iceberg": IcebergBot,
    "scaled_order": ScaledOrderBot,
    "position_snowball": PositionSnowballBot,
    "cross_asset_allocator": CrossAssetAllocatorBot,
}


def build_bot(bot_type: BotType, params: dict[str, Any]):
    cls = BOT_REGISTRY[bot_type]
    return cls(params)

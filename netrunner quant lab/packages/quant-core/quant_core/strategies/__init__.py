from .base import Strategy, StrategyContext, StrategyDecision
from .pmm import PureMarketMaker
from .avellaneda import AvellanedaStoikov
from .funding_fade import FundingFade
from .trend_ema import TrendEmaCross
from .grid import GridTrader
from .twap import TwapExecutor

__all__ = [
    "Strategy",
    "StrategyContext",
    "StrategyDecision",
    "PureMarketMaker",
    "AvellanedaStoikov",
    "FundingFade",
    "TrendEmaCross",
    "GridTrader",
    "TwapExecutor",
]

REGISTRY = {
    "pmm": PureMarketMaker,
    "avellaneda_stoikov": AvellanedaStoikov,
    "funding_fade": FundingFade,
    "trend_ema_cross": TrendEmaCross,
    "grid": GridTrader,
    "twap": TwapExecutor,
}

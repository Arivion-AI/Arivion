from .engine import (
    BacktestBar,
    FundingRow,
    MarginTier,
    Position,
    EventBacktestEngine,
    apply_funding_events,
    check_liquidation,
    market_fill_from_signal,
    resolve_intrabar_exit,
    strict_limit_penetration,
)
from .metrics import sharpe_annualized
from .paper import PaperSessionState, Tick, PaperDecision, evaluate_tick
from .optimizer import ParityThresholds, CandidateMetrics, ParityResult, compute_parity
from .risk import RiskMetrics, RiskGateConfig, RiskEvaluation, evaluate_risk
from .indicators import SMA, EMA, RSI, ATR, BollingerBands, MACD, ZScore, Donchian, VWAP, Keltner, returns
from .orders import Order, OrderType, OrderStatus, TimeInForce, Fill, Bar, OcoGroup, can_fill_market, can_fill_limit, can_fill_stop
from .portfolio import Portfolio, PortfolioPosition, RiskConfig, RiskState
from .performance import PerformanceReport, compute_performance
from .paper_runtime import PaperRuntime, PaperEvent, PaperRunResult
from .bot_os import (
    BotRuntime,
    BotContext,
    BotDecision,
    BotSpec,
    BotType,
    BotValidation,
    OrderIntent,
    BOT_REGISTRY,
    build_bot,
)
from .strategies import (
    Strategy, StrategyContext, StrategyDecision,
    PureMarketMaker, AvellanedaStoikov, FundingFade, TrendEmaCross, GridTrader, TwapExecutor,
    REGISTRY as STRATEGY_REGISTRY,
)

__all__ = [
    "BacktestBar",
    "FundingRow",
    "MarginTier",
    "Position",
    "check_liquidation",
    "EventBacktestEngine",
    "apply_funding_events",
    "market_fill_from_signal",
    "resolve_intrabar_exit",
    "strict_limit_penetration",
    "sharpe_annualized",
    "PaperSessionState",
    "Tick",
    "PaperDecision",
    "evaluate_tick",
    "ParityThresholds",
    "CandidateMetrics",
    "ParityResult",
    "compute_parity",
    "RiskMetrics",
    "RiskGateConfig",
    "RiskEvaluation",
    "evaluate_risk",
    "BotRuntime",
    "BotContext",
    "BotDecision",
    "BotSpec",
    "BotType",
    "BotValidation",
    "OrderIntent",
    "BOT_REGISTRY",
    "build_bot",
]

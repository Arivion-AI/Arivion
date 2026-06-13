from .base import BotRuntime
from .models import BotContext, BotDecision, BotSpec, BotType, BotValidation, OrderIntent
from .registry import BOT_REGISTRY, build_bot
from .templates import TEMPLATES, COMPILER_VERSION, template_by_type
from .validator import validate_bot_spec, spec_hash, EXECUTION_BOT_TYPES
from .recommender import recommend, detect_regime, REGIMES, AFFINITY, Recommendation
from .risk_cockpit import compute_cockpit, CockpitReport
from .executor import run_bot, BotRunReport

__all__ = [
    "BotRuntime",
    "BotContext",
    "BotDecision",
    "BotSpec",
    "BotType",
    "BotValidation",
    "OrderIntent",
    "BOT_REGISTRY",
    "build_bot",
    "TEMPLATES",
    "COMPILER_VERSION",
    "template_by_type",
    "validate_bot_spec",
    "spec_hash",
    "EXECUTION_BOT_TYPES",
    "recommend",
    "detect_regime",
    "REGIMES",
    "AFFINITY",
    "Recommendation",
    "compute_cockpit",
    "CockpitReport",
    "run_bot",
    "BotRunReport",
]

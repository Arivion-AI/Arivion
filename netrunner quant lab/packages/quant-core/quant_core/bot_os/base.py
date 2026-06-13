from __future__ import annotations

from typing import Any

from .models import BotContext, BotDecision, BotSpec, BotType, BotValidation


class BotRuntime:
    bot_type: BotType

    def validate(self, spec: BotSpec, coverage: dict[str, Any] | None = None) -> BotValidation:
        return BotValidation(valid=True)

    def on_start(self, ctx: BotContext) -> BotDecision:
        return BotDecision()

    def on_bar(self, ctx: BotContext) -> BotDecision:
        return BotDecision()

    def on_fill(self, fill: dict[str, Any], ctx: BotContext) -> BotDecision:
        return BotDecision()

    def on_funding(self, funding_event: dict[str, Any], ctx: BotContext) -> BotDecision:
        return BotDecision()

    def on_stop(self, ctx: BotContext) -> BotDecision:
        return BotDecision()

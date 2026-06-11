from pydantic import BaseModel, Field


class BackfillRequest(BaseModel):
    category: str = "linear"
    symbol: str
    interval: str
    start_ms: int = Field(..., description="Unix ms start inclusive")
    end_ms: int = Field(..., description="Unix ms end inclusive")
    data_version: str = "v1"


class CoverageWindow(BaseModel):
    expected_bars: int
    actual_bars: int
    missing_bars: int
    duplicate_bars: int

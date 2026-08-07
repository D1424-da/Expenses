"""共有 Pydantic モデル。"""
from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, Field


class FamilyComposition(BaseModel):
    adults_m:    int = Field(0, ge=0, le=20)
    adults_f:    int = Field(0, ge=0, le=20)
    toddlers:    int = Field(0, ge=0, le=10)
    elementary:  int = Field(0, ge=0, le=10)
    junior_high: int = Field(0, ge=0, le=10)


class RecipeRequest(BaseModel):
    items:       list[Annotated[str, Field(max_length=200)]] = Field(..., min_length=1, max_length=50)
    servings:    int = Field(2, ge=1, le=20)
    recipe_type: str = Field("meal", pattern="^(meal|weekly|select)$")
    max_minutes: int | None = Field(None, ge=5, le=180)
    use_up:      bool = Field(False)
    family:      FamilyComposition | None = Field(None)
    days:        int | None = Field(None, ge=1, le=7)


class CheckoutRequest(BaseModel):
    email: str = Field(..., max_length=254)


class SyncRequest(BaseModel):
    email: str = Field(..., max_length=254)


class BetaRedeemRequest(BaseModel):
    code: str = Field(..., max_length=50)

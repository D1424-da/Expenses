"""レシピ提案エンドポイント。"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from app import security
from app.models import RecipeRequest
from app.routes._shared import rate_limiter, FIREBASE_PROJECT_ID

logger = logging.getLogger("uvicorn.error")

router = APIRouter()


@router.post("/recipe")
async def suggest_recipe(
    request: Request,
    body: RecipeRequest,
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    """食材リストと人数からレシピを提案する（Gemini 使用）。"""
    uid = security.verify_firebase_token(authorization, FIREBASE_PROJECT_ID)
    if not uid and FIREBASE_PROJECT_ID:
        raise HTTPException(401, "認証が必要です。")
    rate_limiter.check(security.client_ip(request))
    if not body.items:
        raise HTTPException(400, "食材リストが空です。")
    # select タイプはプロンプトが長いため食材数を15品に絞る（Gemini 負荷軽減）
    items = body.items[:15] if body.recipe_type == "select" else body.items
    from app import recipe as recipe_mod
    try:
        text = await asyncio.to_thread(
            recipe_mod.suggest_recipes,
            items, body.servings, body.recipe_type,
            max_minutes=body.max_minutes, use_up=body.use_up,
            family=body.family.model_dump() if body.family else None,
            days=body.days,
        )
        return JSONResponse({"recipe": text})
    except RuntimeError as exc:
        msg = str(exc)
        logger.error("Recipe suggest RuntimeError: %s", msg)
        if "GEMINI_API_KEY が設定されていません" in msg or "設定されていません" in msg:
            raise HTTPException(503, "レシピ提案サービスが設定されていません。") from exc
        if "429" in msg or "RESOURCE_EXHAUSTED" in msg or "credits" in msg.lower():
            raise HTTPException(503, "AIサービスの利用上限に達しました。しばらく待ってから再試行してください。") from exc
        if "404" in msg:
            raise HTTPException(503, f"AIモデルが見つかりません: {msg[:200]}") from exc
        raise HTTPException(503, f"レシピ生成エラー: {msg[:300]}") from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("Recipe suggestion failed")
        raise HTTPException(500, "レシピの提案に失敗しました。時間をおいて再試行してください。") from exc

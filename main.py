"""レシートOCRサービス — FastAPI エントリポイント。

役割分担:
- app/models.py              : Pydantic モデル
- app/routes/ocr.py          : OCR・ヘルスチェック
- app/routes/recipe.py       : レシピ提案
- app/routes/stripe_routes.py: Stripe サブスクリプション
- app/routes/_shared.py      : レートリミッターなど共有シングルトン
- app/security.py            : 画像検証・レート制限・Firebase 認証
- app/engines.py             : OCR エンジンの選択と多段フォールバック

起動（ローカル開発）:
    uvicorn main:app --reload
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app import debug_storage
from app.routes import admin, ocr, recipe, stripe_routes
from app.stripe_billing import startup_firebase_admin

logger = logging.getLogger("uvicorn.error")

BASE_DIR   = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


def _safe_bucket_name() -> str:
    """起動ログ用。未設定でも例外で起動を止めない。"""
    try:
        return debug_storage.bucket_name()
    except Exception as exc:  # noqa: BLE001 — ログ用途なので失敗しても続行
        return f"未解決（{exc}）"


@asynccontextmanager
async def _lifespan(application: FastAPI):
    startup_firebase_admin()
    # 一時保存の設定はログに出しておく。有効/無効やバケット名の取り違えは
    # 画面上は「該当する画像はありません」としか出ず切り分けが難しいため。
    logger.info(
        "レシート一時保存: %s（バケット: %s / 保持 %d 日）",
        "有効" if debug_storage.RETAIN_ENABLED else "無効",
        _safe_bucket_name(),
        debug_storage.RETAIN_DAYS,
    )
    yield


app = FastAPI(title="レシートOCRサービス", lifespan=_lifespan)


def _allowed_origins() -> list[str]:
    """CORS_ORIGINS（カンマ区切り）から許可オリジンを組み立てる。

    未設定時は空リスト（フェイルクローズ）。ローカル開発には
    CORS_ORIGINS=http://localhost:8000 のように明示的に設定すること。
    """
    origins = os.environ.get("CORS_ORIGINS", "").strip()
    if not origins:
        return []
    if origins == "*":
        return ["*"]
    return [o.strip() for o in origins.split(",") if o.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(ocr.router,           prefix="/api")
app.include_router(recipe.router,        prefix="/api")
app.include_router(stripe_routes.router, prefix="/api")
app.include_router(admin.router,         prefix="/api")

# フロント配信（ローカル開発用。本番は Firebase Hosting を使う）
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

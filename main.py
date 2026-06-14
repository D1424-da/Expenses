"""レシートOCR家計簿アプリ — FastAPI エントリポイント。

起動:
    uvicorn main:app --reload
ブラウザで http://localhost:8000 を開く。
"""
from __future__ import annotations

import datetime as dt
import json
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import db, ocr, parser

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
UPLOAD_DIR = BASE_DIR / "data" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/jpg"}
MAX_BYTES = 15 * 1024 * 1024  # 15MB

app = FastAPI(title="レシート家計簿")


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


# ---- API -------------------------------------------------------------------


@app.get("/api/categories")
def get_categories() -> dict:
    return {"categories": db.CATEGORIES}


@app.post("/api/ocr")
async def ocr_receipt(file: UploadFile = File(...)) -> JSONResponse:
    """レシート画像を受け取り、OCR → 項目抽出した結果を返す（保存はしない）。"""
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"対応していない画像形式です: {file.content_type}")
    image_bytes = await file.read()
    if len(image_bytes) > MAX_BYTES:
        raise HTTPException(400, "画像サイズが大きすぎます（最大15MB）。")
    if not image_bytes:
        raise HTTPException(400, "空のファイルです。")

    # アップロード画像を保存（後でレシート確認用に紐づけられる）
    ext = (Path(file.filename or "").suffix or ".jpg").lower()
    stored_name = f"{uuid.uuid4().hex}{ext}"
    (UPLOAD_DIR / stored_name).write_bytes(image_bytes)

    try:
        text = ocr.run_ocr(image_bytes)
    except Exception as exc:  # noqa: BLE001 — ユーザーに原因を返す
        raise HTTPException(500, f"OCR に失敗しました: {exc}") from exc

    parsed = parser.parse_receipt(text)
    parsed["image_path"] = stored_name
    return JSONResponse(parsed)


@app.get("/api/expenses")
def list_expenses(month: str | None = None, category: str | None = None) -> dict:
    return {"expenses": db.list_expenses(month=month, category=category)}


@app.post("/api/expenses")
async def create_expense(
    date: str = Form(...),
    store: str = Form(""),
    amount: int = Form(0),
    category: str = Form("その他"),
    memo: str = Form(""),
    items: str = Form("[]"),
    image_path: str | None = Form(None),
    raw_text: str | None = Form(None),
) -> dict:
    try:
        parsed_items = json.loads(items)
    except json.JSONDecodeError:
        parsed_items = []
    expense = db.create_expense(
        {
            "date": date,
            "store": store,
            "amount": amount,
            "category": category,
            "memo": memo,
            "items": parsed_items,
            "image_path": image_path,
            "raw_text": raw_text,
        }
    )
    return {"expense": expense}


@app.put("/api/expenses/{expense_id}")
async def update_expense(
    expense_id: int,
    date: str = Form(...),
    store: str = Form(""),
    amount: int = Form(0),
    category: str = Form("その他"),
    memo: str = Form(""),
    items: str = Form("[]"),
) -> dict:
    try:
        parsed_items = json.loads(items)
    except json.JSONDecodeError:
        parsed_items = []
    expense = db.update_expense(
        expense_id,
        {
            "date": date,
            "store": store,
            "amount": amount,
            "category": category,
            "memo": memo,
            "items": parsed_items,
        },
    )
    if not expense:
        raise HTTPException(404, "該当の支出が見つかりません。")
    return {"expense": expense}


@app.delete("/api/expenses/{expense_id}")
def delete_expense(expense_id: int) -> dict:
    if not db.delete_expense(expense_id):
        raise HTTPException(404, "該当の支出が見つかりません。")
    return {"ok": True}


@app.get("/api/summary")
def summary(month: str | None = None) -> dict:
    if not month:
        month = dt.date.today().strftime("%Y-%m")
    return db.monthly_summary(month)


@app.get("/api/image/{name}")
def get_image(name: str) -> FileResponse:
    # パストラバーサル対策: ファイル名のみ許可
    safe = Path(name).name
    path = UPLOAD_DIR / safe
    if not path.exists():
        raise HTTPException(404, "画像が見つかりません。")
    return FileResponse(path)


# ---- フロント配信 -----------------------------------------------------------


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

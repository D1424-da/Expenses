"""OCR エンジンの選択と多段フォールバック。

エンジンは大きく2系統ある:
- AI 系（gemini / vertex）: 画像から直接構造化抽出する（高精度）。
  失敗したらもう一方の AI → Vision（OCR + 正規表現パーサ）の順で粘る。
- tesseract: OpenCV/Tesseract でローカル OCR → 正規表現パーサ。

AI 系のモジュールは依存が任意（軽量デプロイでは未導入）なので、import に
失敗しても起動できるよう None にフォールバックする。
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger("uvicorn.error")

# Gemini Developer API（APIキー / AI Studio 課金）。任意の依存。
try:
    from app import gemini
except Exception:  # noqa: BLE001 — gemini は任意
    gemini = None  # type: ignore
# Vertex AI 版 Gemini（Google Cloud 課金=無料トライアル等で動かす）。任意の依存。
try:
    from app import vertex
except Exception:  # noqa: BLE001 — vertex は任意
    vertex = None  # type: ignore
# Vision は AI が失敗したときの保険（OCR専用）。任意の依存にする。
try:
    from app import vision
except Exception:  # noqa: BLE001 — vision は任意
    vision = None  # type: ignore

AI_ENGINES = ("gemini", "vertex")
_AI_LABELS = {"gemini": "Gemini", "vertex": "Vertex AI"}


class ExtractionError(RuntimeError):
    """利用可能なエンジンをすべて試しても抽出できなかった。"""


def extract_with_ai(preferred: str, image_bytes: bytes, content_type: str = "image/jpeg") -> dict:
    """AI で画像から直接構造化抽出する（多段フォールバック付き）。

    設定エンジンを先頭に、もう一方の AI → Vision の順で試す。
    （例 preferred=gemini なら gemini → vertex → Vision。それでも駄目なら
    ExtractionError を投げ、最後はブラウザ側の PaddleOCR に委ねる）
    鍵・資格情報はサーバーの環境変数に保持し、フロントには出さない。
    """
    modules = {"gemini": gemini, "vertex": vertex}
    # 設定エンジンを先頭にした試行順（重複なし）。
    order = [preferred] + [e for e in AI_ENGINES if e != preferred]

    errors: list[str] = []
    for name in order:
        module = modules.get(name)
        if module is None:
            continue  # 依存未導入などで利用不可ならスキップ
        try:
            return module.extract_receipt(image_bytes, content_type)
        except Exception as exc:  # noqa: BLE001 — 次の手段へ
            logger.exception("%s OCR failed", _AI_LABELS[name])
            errors.append(f"{_AI_LABELS[name]}: {exc}")

    # すべての AI が失敗 → VISION_API_KEY があれば Vision で再試行（OCR専用）。
    if vision is not None and os.environ.get("VISION_API_KEY"):
        try:
            logger.warning("AI 全滅。Vision にフォールバックします。")
            result = vision.extract_receipt(image_bytes)
            result["engine"] = "vision"  # フロントの履歴正規化の対象
            return result
        except Exception as vexc:  # noqa: BLE001 — フォールバックも失敗
            logger.exception("Vision fallback failed")
            errors.append(f"Vision フォールバックも失敗: {vexc}")

    # 失敗の詳細（プロバイダ由来の文言）はログにのみ残し、呼び出し側は
    # 内部情報を含まない一般的なメッセージをクライアントへ返す。
    logger.error("AI OCR 全失敗: %s", " / ".join(errors))
    raise ExtractionError("すべての AI エンジンで抽出に失敗しました。")


def extract_with_tesseract(image_bytes: bytes) -> dict:
    """Tesseract で OCR → 正規表現パーサで構造化する。"""
    # 遅延 import（OpenCV/Tesseract が必要なときだけ読み込む）
    from app import ocr, parser

    text = ocr.run_ocr(image_bytes)
    result = parser.parse_receipt(text)
    result["engine"] = "tesseract"  # フロントの履歴正規化の対象
    return result

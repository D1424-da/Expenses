"""Vertex AI 版 Gemini によるレシート抽出（Google Cloud 課金で動かす）。

Gemini Developer API（``app/gemini.py``）は API キー1個で手軽だが、課金は
AI Studio のプロジェクトに紐づく。一方こちらは **Vertex AI**
(``aiplatform.googleapis.com``) を OAuth で呼ぶため、**Google Cloud の課金
アカウント（無料トライアルの $300 クレジット等）をそのまま消費**できる。

抽出のプロンプト・後処理は Gemini Developer API と共通（``app.gemini`` を再利用）。
レスポンス形式も generateContent で同じなので、認証とエンドポイントだけが違う。

必要な環境変数:
- ``GOOGLE_CLOUD_PROJECT``           : 課金が紐づく GCP プロジェクトID（必須）
- ``VERTEX_LOCATION``                : リージョン（既定 ``us-central1``。``global`` 可）
- ``VERTEX_MODEL`` / ``GEMINI_MODEL``: モデル（既定 ``gemini-2.0-flash-001``）
- 認証は次のいずれか:
    - ``GOOGLE_SERVICE_ACCOUNT_JSON`` : サービスアカウント鍵のJSON文字列（Render向け）
    - ``GOOGLE_APPLICATION_CREDENTIALS`` : 鍵ファイルのパス（ADC 標準）
    - それも無ければ実行環境の既定資格情報（ADC）を使う
"""
from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time

from app import gemini, net

logger = logging.getLogger("uvicorn.error")

_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
_creds_lock = threading.Lock()
_cached_creds = None


def _get_access_token() -> str:
    """Vertex を呼ぶための OAuth アクセストークンを取得する。

    認証情報をモジュールレベルでキャッシュし、有効期限が切れた場合のみ再取得する。
    """
    global _cached_creds
    try:
        import google.auth
        import google.auth.transport.requests
        from google.oauth2 import service_account
    except ImportError as exc:
        raise RuntimeError(
            "Vertex を使うには google-auth が必要です（requirements に追加してください）。"
        ) from exc

    with _creds_lock:
        if _cached_creds is not None and _cached_creds.valid:
            return _cached_creds.token

        sa_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
        if sa_json:
            info = json.loads(sa_json)
            creds = service_account.Credentials.from_service_account_info(info, scopes=_SCOPES)
        else:
            creds, _ = google.auth.default(scopes=_SCOPES)

        req = google.auth.transport.requests.Request()
        creds.refresh(req)
        if not creds.token:
            raise RuntimeError("Vertex 用のアクセストークンを取得できませんでした。")

        _cached_creds = creds
        return creds.token


# プロジェクトによって Vertex AI で使えるモデル名が異なる（Model Garden の
# 有効化状況次第）ため、VERTEX_MODEL 未指定時は候補を順に試す。
# 新しいモデルほど先に置く（将来の移行を自動で拾うため）。
_VERTEX_MODEL_CANDIDATES = [
    "gemini-3.5-flash",        # 第一希望。Model Garden で有効化され次第これが使われる
    "gemini-3.1-flash-lite",   # Gemini 2.5廃止の推奨移行先
    "gemini-2.0-flash-001",
    "gemini-2.0-flash-002",
    "gemini-1.5-flash-001",
    "gemini-1.5-flash-002",
    "gemini-1.5-pro-001",
    "gemini-2.5-flash",        # 2026-10-20 サポート終了予定
]

# 一度成功したモデルを覚えておく。覚えないと、利用できないモデルへの 404 を
# 毎リクエスト繰り返すことになる（実測で1回のOCRに7往復の無駄が発生していた）。
# プロセス内キャッシュなので再起動でリセットされ、モデルの廃止・追加は
# 次回の全候補走査で自動的に拾い直せる。
_model_lock = threading.Lock()
_working_model: str | None = None


def _candidate_order(env_model: str | None, cached: str | None) -> list[str]:
    """試行順を決める（純粋関数）。

    - VERTEX_MODEL が明示されていればそれだけを使う（従来どおり）
    - 前回成功したモデルがあれば先頭に持ってくる
    """
    if env_model:
        return [env_model]
    if cached:
        return [cached] + [m for m in _VERTEX_MODEL_CANDIDATES if m != cached]
    return list(_VERTEX_MODEL_CANDIDATES)


def _get_working_model() -> str | None:
    with _model_lock:
        return _working_model


def _set_working_model(model: str | None) -> None:
    global _working_model
    with _model_lock:
        _working_model = model


def extract_receipt(image_bytes: bytes, content_type: str = "image/jpeg") -> dict:
    """Vertex AI（Gemini）で画像から構造化レシートデータを抽出する。"""
    project = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("VERTEX_PROJECT")
    if not project:
        raise RuntimeError("GOOGLE_CLOUD_PROJECT が設定されていません。")
    location = os.environ.get("VERTEX_LOCATION", "us-central1")
    env_model = os.environ.get("VERTEX_MODEL")
    cached = _get_working_model()
    candidates = _candidate_order(env_model, cached)

    logger.info(
        "Vertex AI 呼び出し: project=%s location=%s model=%s 画像=%.1fKB",
        project, location,
        env_model or (f"{cached}（前回成功）" if cached else f"自動選択（候補{len(candidates)}件）"),
        len(image_bytes) / 1024,
    )

    try:
        token = _get_access_token()
    except Exception as exc:
        # 認証はモデル選択より前段。ここで落ちるとモデル別ログすら出ないため
        # 「認証で失敗した」ことを明示する（IAM権限・鍵JSONの不備の切り分け用）。
        logger.error("Vertex AI 認証に失敗（サービスアカウント鍵/IAM権限を確認）: %s", exc)
        raise

    b64 = base64.standard_b64encode(image_bytes).decode("ascii")

    # global は host にリージョン接頭辞を付けない。
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
    body = gemini.build_request_body(b64, content_type)

    errors: list[str] = []
    started = time.monotonic()
    for model in candidates:
        url = (
            f"https://{host}/v1/projects/{project}/locations/{location}"
            f"/publishers/google/models/{model}:generateContent"
        )
        try:
            result = net.post_json(
                url, body,
                headers={"Authorization": f"Bearer {token}"},
                service="Vertex AI",
            )
            structured, text = gemini.parse_generate_content(result)
            normalized = gemini.normalize_receipt(structured, text, engine="vertex")
            # 次回は先頭で試せるよう記憶する（404の繰り返しを避ける）
            if not env_model and model != cached:
                _set_working_model(model)
                logger.info("Vertex AI: 以後 %s を優先して使用します", model)
            logger.info(
                "Vertex AI 成功: model=%s %.1f秒 店名=%s 金額=%s 明細=%d件",
                model, time.monotonic() - started,
                normalized.get("store") or "(未取得)",
                normalized.get("amount"),
                len(normalized.get("items") or []),
            )
            return normalized
        except Exception as exc:
            # 候補を順に試す設計上ここは想定内の失敗だが、記録しないと
            # 「Vertexが全滅した理由」が最後まで分からず切り分けできない。
            logger.warning("Vertex AI: モデル %s 失敗: %s", model, str(exc)[:300])
            errors.append(f"{model}: {exc}")
            # 覚えていたモデルが使えなくなった（廃止など）ら忘れて他を探す
            if model == cached:
                _set_working_model(None)
                logger.warning("Vertex AI: 記憶していた %s が使えなくなったため候補を探し直します", model)
    raise RuntimeError("Vertex AI: 利用可能なモデルが見つかりませんでした / " + " / ".join(errors))

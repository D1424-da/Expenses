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
- ``VERTEX_MODEL`` / ``GEMINI_MODEL``: モデル（既定 ``gemini-2.5-flash``）
- 認証は次のいずれか:
    - ``GOOGLE_SERVICE_ACCOUNT_JSON`` : サービスアカウント鍵のJSON文字列（Render向け）
    - ``GOOGLE_APPLICATION_CREDENTIALS`` : 鍵ファイルのパス（ADC 標準）
    - それも無ければ実行環境の既定資格情報（ADC）を使う
"""
from __future__ import annotations

import base64
import json
import os

from app import gemini, net

_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def _get_access_token() -> str:
    """Vertex を呼ぶための OAuth アクセストークンを取得する。

    google-auth に依存する（サービスアカウント鍵の JWT 署名が必要なため、
    標準ライブラリだけでは現実的でない）。
    """
    try:
        import google.auth
        import google.auth.transport.requests
        from google.oauth2 import service_account
    except ImportError as exc:  # 依存未導入のときは原因を明示
        raise RuntimeError(
            "Vertex を使うには google-auth が必要です（requirements に追加してください）。"
        ) from exc

    sa_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if sa_json:
        # Render 等、鍵ファイルを置きにくい環境向け: JSON 文字列から直接生成。
        info = json.loads(sa_json)
        creds = service_account.Credentials.from_service_account_info(info, scopes=_SCOPES)
    else:
        # GOOGLE_APPLICATION_CREDENTIALS or 実行環境の既定資格情報（ADC）。
        creds, _ = google.auth.default(scopes=_SCOPES)

    creds.refresh(google.auth.transport.requests.Request())
    if not creds.token:
        raise RuntimeError("Vertex 用のアクセストークンを取得できませんでした。")
    return creds.token


def extract_receipt(image_bytes: bytes) -> dict:
    """Vertex AI（Gemini）で画像から構造化レシートデータを抽出する。"""
    project = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("VERTEX_PROJECT")
    if not project:
        raise RuntimeError("GOOGLE_CLOUD_PROJECT が設定されていません。")
    location = os.environ.get("VERTEX_LOCATION", "us-central1")
    model = os.environ.get("VERTEX_MODEL") or os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

    token = _get_access_token()
    b64 = base64.standard_b64encode(image_bytes).decode("ascii")

    # global は host にリージョン接頭辞を付けない。
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
    url = (
        f"https://{host}/v1/projects/{project}/locations/{location}"
        f"/publishers/google/models/{model}:generateContent"
    )
    result = net.post_json(
        url,
        gemini.build_request_body(b64),
        headers={"Authorization": f"Bearer {token}"},
        service="Vertex AI",
    )
    structured, text = gemini.parse_generate_content(result)
    return gemini.normalize_receipt(structured, text, engine="vertex")

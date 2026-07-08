"""Google 系 API への JSON POST 共通処理（標準ライブラリのみ）。

Gemini / Vertex / Vision はいずれも「JSON を POST して JSON を受け取る」だけの
呼び出しなので、リクエスト組み立てと HTTP エラーの文言整形をここに集約する。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request


def post_json(
    url: str,
    body: dict,
    *,
    headers: dict[str, str] | None = None,
    timeout: int = 60,
    service: str = "API",
) -> dict:
    """JSON を POST してレスポンス JSON を返す。

    HTTP エラー時は、プロバイダのエラー本文（キー不正・API未有効化など）を
    先頭300文字まで含めた RuntimeError にして原因を追いやすくする。
    """
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — 固定の信頼できるURL
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"{service} エラー (HTTP {exc.code}): {detail}") from exc

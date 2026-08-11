"""/api/ocr を守るための入口チェック（画像検証・レート制限・認証）。

認証なしでも公開できるエンドポイントのため、課金の浪費や DoS を防ぐ
最低限の歯止めをここに集約する。
"""
from __future__ import annotations

import logging
import threading
import time
from collections import deque

from fastapi import HTTPException, Request

logger = logging.getLogger("uvicorn.error")


def looks_like_image(b: bytes) -> bool:
    """画像のマジックバイト検査。content_type はクライアント申告で信用できない。"""
    return (
        b[:3] == b"\xff\xd8\xff"  # JPEG
        or b[:8] == b"\x89PNG\r\n\x1a\n"  # PNG
        or (b[:4] == b"RIFF" and b[8:12] == b"WEBP")  # WEBP
        or b[4:8] == b"ftyp"  # HEIC/HEIF (ISO-BMFF)
    )


def client_ip(request: Request) -> str:
    # Render などのリバースプロキシは信頼できる実IP を XFF の末尾に追記する。
    # 先頭はクライアント申告値で偽装可能なため使わない。
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


class RateLimiter:
    """簡易レート制限（単一インスタンス前提・インメモリ）。

    IP単位＋全体上限のスライディングウィンドウで、認証なしの公開エンドポイントが
    課金を浪費されるのを防ぐ。
    """

    def __init__(self, window_sec: int, per_ip: int, global_limit: int) -> None:
        self.window_sec = window_sec
        self.per_ip = per_ip
        self.global_limit = global_limit
        self._lock = threading.Lock()
        self._by_ip: dict[str, deque[float]] = {}
        self._global: deque[float] = deque()
        self._last_cleanup = 0.0  # _by_ip の空エントリを最後に掃除した時刻

    def check(self, ip: str) -> None:
        """上限超過なら 429 を投げる。通れば今回のリクエストを記録する。"""
        now = time.time()
        cutoff = now - self.window_sec
        with self._lock:
            while self._global and self._global[0] < cutoff:
                self._global.popleft()
            dq = self._by_ip.setdefault(ip, deque())
            while dq and dq[0] < cutoff:
                dq.popleft()
            if len(dq) >= self.per_ip or len(self._global) >= self.global_limit:
                raise HTTPException(429, "リクエストが多すぎます。しばらく待って再試行してください。")
            dq.append(now)
            self._global.append(now)
            # 空になったエントリを除去してメモリリークを防ぐ。
            #
            # 以前は「IP が 1000 種類を超えたら毎回作り直す」という条件だったが、
            # 直近アクセスのある IP は空にならないため辞書が 1000 未満に戻らず、
            # 一度超えると全リクエストで O(n) のコピーが走り続けていた
            # （＝全体が O(n^2)。IP が増えるほど遅くなる）。
            # 掃除の間隔は window_sec で足りる。
            #
            # 判定条件も修正した。以前は「deque が空」なら除去していたが、
            # 各 IP の deque が刈られるのはその IP が再訪したときだけなので、
            # 二度と来ない IP には期限切れのタイムスタンプが残り続け、空にならない。
            # 結果としてリーク対策として機能していなかった。
            # 最終アクセスが window_sec より古いエントリを除去する。
            if now - self._last_cleanup >= self.window_sec:
                self._by_ip = {
                    k: v for k, v in self._by_ip.items() if v and v[-1] >= cutoff
                }
                self._last_cleanup = now


def verify_firebase_token(authorization: str | None, project_id: str) -> str | None:
    """project_id 設定時のみ、Firebase ID トークンを検証して uid を返す。

    未設定なら認証はスキップ（レート制限のみで保護）して None を返す。
    本番環境では必ず FIREBASE_PROJECT_ID を設定すること。
    """
    if not project_id:
        logger.warning("FIREBASE_PROJECT_ID が未設定のため認証をスキップしています。本番環境では設定してください。")
        return None
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not token:
        raise HTTPException(401, "認証が必要です。")
    try:
        from google.auth.transport import requests as ga_requests
        from google.oauth2 import id_token as google_id_token
        claims = google_id_token.verify_firebase_token(
            token, ga_requests.Request(), audience=project_id
        )
        return claims["sub"]  # Firebase UID
    except HTTPException:
        raise
    except Exception:  # noqa: BLE001 — 検証失敗は一律 401（詳細はサーバーログのみ）
        logger.exception("ID トークン検証に失敗")
        raise HTTPException(401, "認証に失敗しました。") from None

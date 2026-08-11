"""AI エンジンのサーキットブレーカー（単一インスタンス前提・インメモリ）。

クレジット枯渇やレート制限で確実に失敗すると分かっているエンジンを、
一定時間だけ試行対象から外す。これがないと毎リクエストで必ず失敗する
API 呼び出しを待たされ、レイテンシとログのノイズが増え続ける。

`RateLimiter`（app/security.py）と同じく、単一インスタンス運用を前提に
プロセス内で状態を持つ。再起動すると状態は消える（＝再度1回だけ試す）。
"""
from __future__ import annotations

import logging
import threading
import time

logger = logging.getLogger("uvicorn.error")

# クレジット枯渇は入金するまで回復しないので長めに止める。
COOLDOWN_CREDITS_SEC = 30 * 60
# 一時的なレート制限・サーバ側障害は短時間で回復しうる。
COOLDOWN_TRANSIENT_SEC = 60

# エラー文面からクレジット枯渇（＝待っても直らない）と判断するキーワード。
_CREDIT_MARKERS = (
    "prepayment credits are depleted",
    "credits are depleted",
    "billing",
    "quota exceeded",
    "insufficient_quota",
)
# 一時的な失敗（＝しばらくすれば直るかもしれない）と判断するキーワード。
_TRANSIENT_MARKERS = ("429", "resource_exhausted", "rate limit", "503", "unavailable")


def classify(message: str) -> int | None:
    """エラー文面から停止すべき秒数を返す。停止不要なら None。"""
    m = message.lower()
    if any(k in m for k in _CREDIT_MARKERS):
        return COOLDOWN_CREDITS_SEC
    if any(k in m for k in _TRANSIENT_MARKERS):
        return COOLDOWN_TRANSIENT_SEC
    return None


class EngineBreaker:
    """エンジン名ごとに「いつまで休ませるか」を保持する。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._open_until: dict[str, float] = {}

    def is_open(self, name: str, now: float | None = None) -> bool:
        """True ならこのエンジンは今スキップすべき。"""
        now = time.time() if now is None else now
        with self._lock:
            until = self._open_until.get(name)
            if until is None:
                return False
            if until <= now:
                del self._open_until[name]  # 期限切れ → 再度試す
                return False
            return True

    def record_failure(self, name: str, message: str, now: float | None = None) -> None:
        """失敗を記録し、内容によっては一定時間そのエンジンを止める。"""
        cooldown = classify(message)
        if cooldown is None:
            return
        now = time.time() if now is None else now
        with self._lock:
            self._open_until[name] = now + cooldown
        logger.warning(
            "%s を %d 分間スキップします（理由: %s）",
            name, cooldown // 60, message[:120],
        )

    def record_success(self, name: str) -> None:
        """成功したら停止を解除する（復旧の取りこぼしを防ぐ）。"""
        with self._lock:
            self._open_until.pop(name, None)

    def reset(self) -> None:
        with self._lock:
            self._open_until.clear()


breaker = EngineBreaker()

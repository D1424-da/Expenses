"""ルーター間で共有するシングルトン（レートリミッターなど）。"""
from __future__ import annotations

import os

from app import security

rate_limiter = security.RateLimiter(
    window_sec=int(os.environ.get("RATE_WINDOW_SEC", "60")),
    per_ip=int(os.environ.get("RATE_PER_IP", "10")),
    global_limit=int(os.environ.get("RATE_GLOBAL", "60")),
)

FIREBASE_PROJECT_ID: str = os.environ.get("FIREBASE_PROJECT_ID", "").strip()

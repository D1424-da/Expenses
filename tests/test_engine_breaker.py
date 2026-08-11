"""engine_breaker のテスト — 失敗の分類と一時停止の挙動。"""
from __future__ import annotations

import pytest

from app.engine_breaker import (
    COOLDOWN_CREDITS_SEC,
    COOLDOWN_TRANSIENT_SEC,
    EngineBreaker,
    classify,
)

CREDITS_MSG = (
    "Gemini API エラー (HTTP 429): Your prepayment credits are depleted. "
    "Please go to AI Studio to manage your project and billing."
)


class TestClassify:
    def test_クレジット枯渇は長時間停止(self):
        assert classify(CREDITS_MSG) == COOLDOWN_CREDITS_SEC

    def test_単なるレート制限は短時間停止(self):
        assert classify("Gemini API エラー (HTTP 429): Too Many Requests") == COOLDOWN_TRANSIENT_SEC

    def test_サーバ側障害は短時間停止(self):
        assert classify("HTTP 503 Service Unavailable") == COOLDOWN_TRANSIENT_SEC

    def test_無関係なエラーでは停止しない(self):
        assert classify("画像の解析に失敗しました") is None

    def test_大文字小文字を区別しない(self):
        assert classify("RESOURCE_EXHAUSTED") == COOLDOWN_TRANSIENT_SEC


class TestEngineBreaker:
    def test_初期状態では停止していない(self):
        b = EngineBreaker()
        assert b.is_open("gemini") is False

    def test_クレジット枯渇後はスキップ対象になる(self):
        b = EngineBreaker()
        b.record_failure("gemini", CREDITS_MSG, now=1000.0)
        assert b.is_open("gemini", now=1000.0) is True

    def test_クールダウン経過後は再び試す(self):
        b = EngineBreaker()
        b.record_failure("gemini", CREDITS_MSG, now=1000.0)
        assert b.is_open("gemini", now=1000.0 + COOLDOWN_CREDITS_SEC + 1) is False

    def test_停止するのは該当エンジンだけ(self):
        b = EngineBreaker()
        b.record_failure("gemini", CREDITS_MSG, now=1000.0)
        assert b.is_open("vertex", now=1000.0) is False

    def test_分類対象外のエラーでは停止しない(self):
        b = EngineBreaker()
        b.record_failure("gemini", "画像が壊れています", now=1000.0)
        assert b.is_open("gemini", now=1000.0) is False

    def test_成功したら停止を解除する(self):
        b = EngineBreaker()
        b.record_failure("gemini", CREDITS_MSG, now=1000.0)
        b.record_success("gemini")
        assert b.is_open("gemini", now=1000.0) is False

    def test_resetで全て解除される(self):
        b = EngineBreaker()
        b.record_failure("gemini", CREDITS_MSG, now=1000.0)
        b.record_failure("vertex", CREDITS_MSG, now=1000.0)
        b.reset()
        assert b.is_open("gemini", now=1000.0) is False
        assert b.is_open("vertex", now=1000.0) is False

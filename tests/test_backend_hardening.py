"""バックエンド点検で見つかった問題の回帰テスト。

対象:
  1. Stripe / Firestore の同期呼び出しがイベントループを止めていた
  2. プロバイダの内部エラー文がそのままクライアントに返っていた
  3. OCR_ENGINE 未設定時の既定が、本番に存在しないエンジンだった
  4. アップロードのサイズ制限が読み切ったあとだった
  5. 招待コードの試行回数に uid 単位の上限が無かった
"""
from __future__ import annotations

import asyncio
import inspect
import io
import re
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
from app import stripe_billing
from app.routes import ocr as ocr_route
from app.routes import _shared

ROOT = Path(__file__).resolve().parent.parent
JPEG_MAGIC = b"\xff\xd8\xff\xe0" + b"\x00" * 100


@pytest.fixture()
def client():
    return TestClient(main.app)


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    _shared.rate_limiter._by_ip.clear()
    _shared.rate_limiter._global.clear()
    yield
    _shared.rate_limiter._by_ip.clear()
    _shared.rate_limiter._global.clear()


# ---------------------------------------------------------------------------
# 1. イベントループをブロックしない
# ---------------------------------------------------------------------------

class TestNoBlockingOnEventLoop:
    """Stripe SDK も Firebase Admin SDK も同期APIしか無い。

    async def の中で直接呼ぶと待っているあいだイベントループ全体が止まり、
    単一ワーカーの Render では /api/health を含む全リクエストが待たされる。
    """

    PUBLIC = [
        "create_checkout_session", "sync_subscription", "create_portal_session",
        "handle_webhook", "redeem_beta_code", "ensure_trial",
    ]

    def test_public_api_is_still_awaitable(self):
        """ルーター側が await しているので、公開関数はコルーチンのままであること。"""
        for name in self.PUBLIC:
            fn = getattr(stripe_billing, name)
            assert inspect.iscoroutinefunction(fn), f"{name} がコルーチンでない"

    def test_public_api_delegates_to_thread(self):
        """公開関数の本体が to_thread に渡しているだけであること。"""
        for name in self.PUBLIC:
            src = inspect.getsource(getattr(stripe_billing, name))
            assert "to_thread" in src, f"{name} が同期処理を直接呼んでいる"

    def test_no_blocking_sdk_call_inside_async_def(self):
        """async def の本体に Stripe / Firestore の同期呼び出しが残っていない。"""
        src = (ROOT / "app" / "stripe_billing.py").read_text(encoding="utf-8")
        blocks = re.findall(r"^async def .*?(?=^\S|\Z)", src, re.S | re.M)
        assert blocks, "async def が見つからない"
        for block in blocks:
            body = "\n".join(block.splitlines()[1:])
            for bad in ("stripe.", "ref.set(", "ref.get(", "_get_firestore("):
                assert bad not in body, f"async def の中で {bad} を直接呼んでいる:\n{block[:200]}"

    def test_event_loop_stays_responsive(self):
        """遅い Stripe 呼び出し中でも、別のタスクが進行できる。"""
        import time as _time

        def slow(_uid, _email):
            _time.sleep(0.3)   # 同期のブロッキング処理を模す
            return "https://example.com/checkout"

        async def scenario():
            ticks = 0

            async def ticker():
                nonlocal ticks
                for _ in range(20):
                    await asyncio.sleep(0.01)
                    ticks += 1

            with patch.object(stripe_billing, "_create_checkout_session_sync", slow):
                task = asyncio.create_task(ticker())
                await stripe_billing.create_checkout_session("uid", "a@b.com")
                await task
            return ticks

        ticks = asyncio.run(scenario())
        # ブロックされていれば ticker は動けず 0 に近い値になる
        assert ticks >= 10, f"イベントループがブロックされている（ticks={ticks}）"


# ---------------------------------------------------------------------------
# 2. 内部エラー文を返さない
# ---------------------------------------------------------------------------

class TestNoInternalErrorLeak:
    def test_recipe_error_does_not_expose_provider_body(self, client, monkeypatch):
        """app/net.py がエラー本文を300字まで埋め込むため、そのまま返さない。"""
        monkeypatch.setattr("app.routes.recipe.FIREBASE_PROJECT_ID", "")
        leak = (
            "Gemini エラー (HTTP 400): {\"error\":{\"message\":"
            "\"API key not valid for project my-secret-project-12345\"}}"
        )

        def boom(*_args, **_kwargs):
            raise RuntimeError(leak)

        with patch("app.recipe.suggest_recipes", boom):
            res = client.post("/api/recipe", json={"items": ["卵"], "servings": 2})
        assert res.status_code == 503
        body = res.text
        for secret in ("my-secret-project", "API key", "HTTP 400"):
            assert secret not in body, f"内部情報が漏れている: {secret}"

    def test_recipe_quota_error_is_still_distinguishable(self, client, monkeypatch):
        """利用上限だけは利用者に伝える価値があるので残す。"""
        monkeypatch.setattr("app.routes.recipe.FIREBASE_PROJECT_ID", "")

        def boom(*_args, **_kwargs):
            raise RuntimeError("Gemini エラー (HTTP 429): RESOURCE_EXHAUSTED")

        with patch("app.recipe.suggest_recipes", boom):
            res = client.post("/api/recipe", json={"items": ["卵"], "servings": 2})
        assert res.status_code == 503
        assert "上限" in res.text


# ---------------------------------------------------------------------------
# 3. OCR_ENGINE の既定値
# ---------------------------------------------------------------------------

class TestDefaultEngine:
    def test_default_is_installed_in_production(self, monkeypatch):
        """本番の依存（requirements-gemini.txt）に無いエンジンを既定にしない。

        OpenCV/Tesseract は入っていないため、既定が tesseract のままだと
        ダッシュボードで OCR_ENGINE が消えた瞬間に全 OCR が 500 になる。
        """
        monkeypatch.delenv("OCR_ENGINE", raising=False)
        from app import engines
        assert ocr_route._engine() in engines.AI_ENGINES

    def test_blank_value_falls_back_to_default(self, monkeypatch):
        """空文字が入っていても既定にフォールバックする。"""
        monkeypatch.setenv("OCR_ENGINE", "   ")
        from app import engines
        assert ocr_route._engine() in engines.AI_ENGINES

    def test_health_reports_the_same_engine(self, client, monkeypatch):
        monkeypatch.setenv("OCR_ENGINE", "vertex")
        assert client.get("/api/health").json()["engine"] == "vertex"


# ---------------------------------------------------------------------------
# 4. アップロードサイズ
# ---------------------------------------------------------------------------

class TestUploadSizeLimit:
    def test_oversized_content_length_is_rejected(self, client, monkeypatch):
        """読み切る前に Content-Length で弾く。

        Starlette は 1MB 超をディスクへスプールするため、読んでから
        判定するとディスクを消費できてしまう。
        """
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)
        res = client.post(
            "/api/ocr",
            files={"file": ("big.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")},
            headers={"content-length": str(50 * 1024 * 1024)},
        )
        assert res.status_code == 400
        assert "大きすぎ" in res.text

    def test_normal_upload_is_not_rejected_by_the_precheck(self, client, monkeypatch):
        """通常サイズは Content-Length チェックで落とさない。"""
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)
        res = client.post(
            "/api/ocr",
            files={"file": ("ok.jpg", io.BytesIO(b"not-an-image"), "image/jpeg")},
        )
        # マジックバイト不正の 400 になるはず（サイズ由来ではない）
        assert res.status_code == 400
        assert "大きすぎ" not in res.text


# ---------------------------------------------------------------------------
# 5. 招待コードの総当たり対策
# ---------------------------------------------------------------------------

class TestBetaCodeThrottle:
    @pytest.fixture(autouse=True)
    def _clear(self):
        stripe_billing._beta_attempts.clear()
        yield
        stripe_billing._beta_attempts.clear()

    def test_attempts_are_limited_per_uid(self, monkeypatch):
        """IP を変えても uid 単位で頭打ちになる。"""
        monkeypatch.setattr(stripe_billing, "BETA_CODES", {"VALID"})
        for _ in range(stripe_billing.BETA_MAX_ATTEMPTS):
            assert stripe_billing._redeem_beta_code_sync("uid-1", "WRONG") is False
        with pytest.raises(HTTPException) as exc:
            stripe_billing._redeem_beta_code_sync("uid-1", "WRONG")
        assert exc.value.status_code == 429

    def test_other_users_are_unaffected(self, monkeypatch):
        monkeypatch.setattr(stripe_billing, "BETA_CODES", {"VALID"})
        for _ in range(stripe_billing.BETA_MAX_ATTEMPTS):
            stripe_billing._redeem_beta_code_sync("uid-1", "WRONG")
        assert stripe_billing._redeem_beta_code_sync("uid-2", "WRONG") is False

    def test_expired_attempts_are_cleaned_up(self, monkeypatch):
        """古い記録が残り続けてメモリを食わない。"""
        monkeypatch.setattr(stripe_billing, "BETA_CODES", {"VALID"})
        stripe_billing._beta_attempts["old-uid"] = [0.0]
        stripe_billing._redeem_beta_code_sync("uid-1", "WRONG")
        assert "old-uid" not in stripe_billing._beta_attempts


# ---------------------------------------------------------------------------
# 6. Render 側の重複サイトを検索対象から外す
# ---------------------------------------------------------------------------

class TestNoIndexHeader:
    """main.py の StaticFiles マウントにより、Render 側でも static/ 全体
    （LP・ブログ135記事）が配信される。ローカル開発のための設定だが、
    本番の Render URL でも同じ内容が見えてしまう。

    canonical は get-tohon.online を指しているので致命的ではないが、
    Google がこのコピーを見つけると重複判定にクロール予算を使う。
    """

    def test_static_pages_are_noindex(self, client):
        for path in ("/index.html", "/blog.html", "/robots.txt"):
            res = client.get(path)
            assert res.headers.get("x-robots-tag") == "noindex, nofollow", (
                f"{path} に X-Robots-Tag が付いていない"
            )

    def test_api_responses_also_carry_the_header(self, client):
        """API も同じホストなので同様に除外する。"""
        res = client.get("/api/health")
        assert res.status_code == 200
        assert "noindex" in res.headers.get("x-robots-tag", "")

    def test_robots_txt_does_not_disallow_everything(self):
        """robots.txt でクロールごと止めない。

        Disallow にすると Googlebot が X-Robots-Tag を読めなくなり、
        既にインデックスされたページを消せなくなる。
        """
        robots = (ROOT / "static" / "robots.txt").read_text(encoding="utf-8")
        lines = [
            ln.strip() for ln in robots.splitlines()
            if ln.strip() and not ln.strip().startswith("#")
        ]
        assert "Disallow: /" not in lines, "robots.txt で全体をブロックしている"

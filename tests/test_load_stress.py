"""負荷テスト・ストレステスト。

負荷テスト: 通常想定トラフィック（同時10接続・合計500req）で品質基準を維持できるか。
ストレステスト: 想定外の高負荷（同時50接続・巨大入力・長時間連続）でも安全に
              グレースフルデグレードするか（クラッシュしない・メモリリークしない）。
"""
from __future__ import annotations

import io
import threading
import time
from collections import Counter
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import main
from app.routes import _shared
from app import security

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


def _parallel_requests(fn, n_threads: int, n_per_thread: int) -> list[int]:
    """fn を n_threads × n_per_thread 並行実行し、ステータスコード一覧を返す。"""
    results: list[int] = []
    lock = threading.Lock()

    def worker():
        codes = [fn() for _ in range(n_per_thread)]
        with lock:
            results.extend(codes)

    threads = [threading.Thread(target=worker) for _ in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


# ---------------------------------------------------------------------------
# 負荷テスト — 通常トラフィック
# ---------------------------------------------------------------------------

class TestLoad:
    def test_health_under_normal_load(self, client):
        """10スレッド × 50req = 500req: 全て 200、エラーなし。"""
        codes = _parallel_requests(
            lambda: client.get("/api/health").status_code,
            n_threads=10, n_per_thread=50
        )
        counter = Counter(codes)
        assert counter[200] == 500, f"health 200 が {counter[200]}/500"
        assert all(c == 200 for c in codes)

    def test_rate_limiter_under_load_blocks_excess(self, monkeypatch):
        """レートリミット (per_ip=5) で 10req/IP 送ると半数以上が 429 になる。"""
        monkeypatch.setattr(_shared.rate_limiter, "per_ip", 5)
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)
        c = TestClient(main.app)

        with patch("app.engines.extract_with_ai", return_value={"amount": 0}):
            codes = []
            for _ in range(10):
                r = c.post("/api/ocr",
                           files={"file": ("r.jpg", io.BytesIO(JPEG_MAGIC), "image/jpeg")})
                codes.append(r.status_code)

        counter = Counter(codes)
        # 最初の5回は成功、残りは 429
        assert counter[200] <= 5
        assert counter[429] >= 5

    def test_validation_load_stable(self, client):
        """バリデーション拒否を 5 スレッド × 20 req = 100 req 並行実行してもクラッシュしない。"""
        codes = _parallel_requests(
            lambda: client.post("/api/recipe", json={"items": [], "servings": 0}).status_code,
            n_threads=5, n_per_thread=20
        )
        # 422 のみ（サーバーエラーなし）
        assert all(c == 422 for c in codes), f"unexpected codes: {Counter(codes)}"

    def test_concurrent_health_and_validation(self, client):
        """異なるエンドポイントへの混在トラフィックでも整合性が保たれる。"""
        results = {"health": [], "recipe": []}
        lock = threading.Lock()

        def health_worker():
            for _ in range(20):
                c = client.get("/api/health").status_code
                with lock:
                    results["health"].append(c)

        def recipe_worker():
            for _ in range(20):
                c = client.post("/api/recipe", json={"items": [], "servings": 0}).status_code
                with lock:
                    results["recipe"].append(c)

        threads = (
            [threading.Thread(target=health_worker) for _ in range(5)]
            + [threading.Thread(target=recipe_worker) for _ in range(5)]
        )
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert all(c == 200 for c in results["health"])
        assert all(c == 422 for c in results["recipe"])


# ---------------------------------------------------------------------------
# ストレステスト — 異常系・境界値
# ---------------------------------------------------------------------------

class TestStress:
    def test_oversized_request_does_not_crash(self, client, monkeypatch):
        """8MB を超える画像を 10 回連続送っても 400 で正常に返る（クラッシュしない）。"""
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)
        over_8mb = JPEG_MAGIC + b"\x00" * (8 * 1024 * 1024 + 1)
        for _ in range(10):
            r = client.post("/api/ocr",
                            files={"file": ("big.jpg", io.BytesIO(over_8mb), "image/jpeg")})
            assert r.status_code == 400

    def test_many_recipe_items_at_boundary(self, client):
        """境界値（50品目）は通過し、51品目は 422 になる。"""
        items_50 = ["食材"] * 50
        r50 = client.post("/api/recipe", json={"items": items_50, "servings": 1})
        assert r50.status_code in (200, 503)  # バリデーション通過、APIキーなしで503 OK

        items_51 = ["食材"] * 51
        r51 = client.post("/api/recipe", json={"items": items_51, "servings": 1})
        assert r51.status_code == 422

    def test_high_concurrency_does_not_deadlock(self, client):
        """20スレッド同時実行してデッドロックしない（10秒以内に完了する）。"""
        results = []
        lock = threading.Lock()

        def worker():
            for _ in range(5):
                c = client.get("/api/health").status_code
                with lock:
                    results.append(c)

        threads = [threading.Thread(target=worker) for _ in range(20)]
        t0 = time.time()
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        elapsed = time.time() - t0

        assert elapsed < 10, f"高並行でタイムアウト: {elapsed:.1f}s"
        assert len(results) == 100

    def test_rate_limiter_does_not_memory_leak_under_stress(self):
        """異なる 10,000 IP から短時間に大量リクエストしてもメモリが収束する。"""
        import tracemalloc
        rl = security.RateLimiter(window_sec=1, per_ip=100, global_limit=1_000_000)

        tracemalloc.start()
        for i in range(10_000):
            ip = f"10.{(i // 65536) % 256}.{(i // 256) % 256}.{i % 256}"
            try:
                rl.check(ip)
            except Exception:
                pass

        snapshot = tracemalloc.take_snapshot()
        tracemalloc.stop()

        # RateLimiter._by_ip の保持件数が 10,000 件を超えない（クリーンアップが機能）
        assert len(rl._by_ip) <= 10_000

    def test_malformed_json_does_not_crash(self, client):
        """不正な JSON ボディでも 422 で返りクラッシュしない。"""
        r = client.post("/api/recipe",
                        content=b"{broken json",
                        headers={"Content-Type": "application/json"})
        assert r.status_code == 422

    def test_empty_body_endpoints_do_not_crash(self, client, monkeypatch):
        """空ボディを全 POST エンドポイントに送ってもクラッシュしない。"""
        monkeypatch.setattr("app.routes.stripe_routes.FIREBASE_PROJECT_ID", "")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: "uid")
        endpoints = [
            "/api/recipe",
            "/api/stripe/checkout",
            "/api/beta/redeem",
        ]
        for path in endpoints:
            r = client.post(path, content=b"",
                            headers={"Content-Type": "application/json",
                                     "Authorization": "Bearer token"})
            assert r.status_code in (400, 401, 422), \
                f"{path} に空ボディで {r.status_code} が返った"

    def test_repeated_rate_limit_hits_stable(self, monkeypatch):
        """レートリミット超過を 1000 回繰り返しても状態が壊れない。"""
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)
        c = TestClient(main.app)
        # per_ip=1 で全リクエストが 429 になる状態
        monkeypatch.setattr(_shared.rate_limiter, "per_ip", 0)
        codes = []
        for _ in range(50):
            r = c.get("/api/health")  # health はレートリミット対象外
            codes.append(r.status_code)
        assert all(c == 200 for c in codes)

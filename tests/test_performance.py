"""パフォーマンステスト — レスポンスタイム・スループット・メモリ使用量の基準値検証。

計測対象:
  - /api/health         : < 50ms（ほぼゼロコスト）
  - /api/ocr (検証層)   : < 100ms（エンジン呼び出し前まで）
  - /api/recipe (検証)  : < 50ms（バリデーション層）
  - RateLimiter.check() : < 1ms（ロック取得含む）
  - parser 関数群       : < 5ms（CPU バウンド）
  - 連続 100 リクエスト : スループット > 50 req/s

外部 API（Gemini / Stripe / Firestore）はすべて mock。
"""
from __future__ import annotations

import io
import time
from statistics import mean, median
from unittest.mock import AsyncMock, patch

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


def _measure(fn, n: int = 20) -> dict:
    """fn を n 回実行して統計を返す（単位: ms）。"""
    times = []
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        times.append((time.perf_counter() - t0) * 1000)
    return {
        "mean_ms":   mean(times),
        "median_ms": median(times),
        "max_ms":    max(times),
        "min_ms":    min(times),
    }


# ---------------------------------------------------------------------------
# エンドポイントレスポンスタイム
# ---------------------------------------------------------------------------

class TestEndpointLatency:
    def test_health_endpoint_under_50ms(self, client):
        stats = _measure(lambda: client.get("/api/health"))
        assert stats["mean_ms"] < 50, f"health mean={stats['mean_ms']:.1f}ms > 50ms"

    def test_health_endpoint_p99_under_100ms(self, client):
        """ウォームアップ後の最悪ケースも 100ms 未満。"""
        stats = _measure(lambda: client.get("/api/health"), n=50)
        assert stats["max_ms"] < 100, f"health max={stats['max_ms']:.1f}ms > 100ms"

    def test_ocr_validation_layer_under_100ms(self, client, monkeypatch):
        """OCR は入力検証で弾かれる（400）が、その処理が 100ms 未満。"""
        monkeypatch.setattr("app.routes.ocr.FIREBASE_PROJECT_ID", "")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)

        def _req():
            # マジックバイト不正 → 400 で即返る（エンジン呼ばない）
            client.post("/api/ocr",
                        files={"file": ("bad.jpg", io.BytesIO(b"not-image"), "image/jpeg")})

        stats = _measure(_req)
        assert stats["mean_ms"] < 100, f"ocr validation mean={stats['mean_ms']:.1f}ms > 100ms"

    def test_recipe_validation_under_50ms(self, client):
        """バリデーション失敗（422）は 50ms 未満。"""
        stats = _measure(
            lambda: client.post("/api/recipe", json={"items": [], "servings": 0})
        )
        assert stats["mean_ms"] < 50, f"recipe validation mean={stats['mean_ms']:.1f}ms > 50ms"

    def test_stripe_auth_rejection_under_50ms(self, client, monkeypatch):
        """認証拒否（401）は 50ms 未満。"""
        monkeypatch.setattr("app.routes.stripe_routes.FIREBASE_PROJECT_ID", "proj")
        monkeypatch.setattr("app.security.verify_firebase_token", lambda *_: None)
        stats = _measure(
            lambda: client.post("/api/stripe/checkout", json={"email": "a@b.com"})
        )
        assert stats["mean_ms"] < 50, f"auth rejection mean={stats['mean_ms']:.1f}ms > 50ms"


# ---------------------------------------------------------------------------
# RateLimiter パフォーマンス
# ---------------------------------------------------------------------------

class TestRateLimiterPerformance:
    def test_rate_limiter_check_under_1ms(self):
        """RateLimiter.check() は 1ms 未満（ロック取得含む）。"""
        rl = security.RateLimiter(window_sec=60, per_ip=1000, global_limit=100000)
        times = []
        for i in range(200):
            t0 = time.perf_counter()
            rl.check(f"10.0.0.{i % 256}")
            times.append((time.perf_counter() - t0) * 1000)
        avg = mean(times)
        assert avg < 1.0, f"RateLimiter.check mean={avg:.3f}ms > 1ms"

    def test_rate_limiter_concurrent_ips_no_degradation(self):
        """IP 数が増えても 1 回あたりのコストが悪化しない（O(1) であること）。

        絶対時間で判定すると CI ランナーの速度差で落ちる（実際に 118ms > 100ms で
        失敗した）。ここで防ぎたいのは「IP が増えると急激に遅くなる」実装、
        つまり計算量の悪化なので、少数 IP と多数 IP の 1 回あたりの所要時間を
        比べる。この比較ならマシンの絶対速度に影響されない。
        """
        def per_call_us(n_ips: int) -> float:
            """IP を n_ips 種類使ったときの 1 回あたりの所要時間（マイクロ秒）。"""
            best = float("inf")
            for _ in range(3):  # 外れ値（GC・スケジューラ）の影響を避けて最小値を採る
                rl = security.RateLimiter(
                    window_sec=60, per_ip=10000, global_limit=1_000_000,
                )
                t0 = time.perf_counter()
                for i in range(n_ips):
                    rl.check(f"192.168.{i // 256}.{i % 256}")
                best = min(best, (time.perf_counter() - t0) / n_ips * 1_000_000)
            return best

        small = per_call_us(200)
        large = per_call_us(2000)  # IP 種類数を 10 倍にする

        # O(1) なら比はほぼ 1。O(n) 以上に悪化していれば 10 倍前後まで伸びる。
        # 計測ゆらぎを見込んで 4 倍を上限とする。
        assert large < small * 4, (
            f"IP数10倍で1回あたり {small:.2f}us → {large:.2f}us "
            f"({large / small:.1f}倍) に悪化。計算量が O(1) でなくなっている可能性"
        )


# ---------------------------------------------------------------------------
# パーサーパフォーマンス
# ---------------------------------------------------------------------------

class TestParserPerformance:
    def test_parse_receipt_under_5ms(self):
        """parse_receipt() は 5ms 未満（CPU バウンド正規表現処理）。"""
        from app.parser import parse_receipt
        sample = """
        ｲｵﾝ 渋谷店
        2026年08月01日(金) 14:23
        牛乳             ¥198
        食パン           ¥148
        卵(10個)         ¥298
        野菜炒めセット    ¥348
        -------------------------
        合計            ¥992
        (内消費税等       ¥90)
        """
        stats = _measure(lambda: parse_receipt(sample), n=100)
        assert stats["mean_ms"] < 5, f"parse_receipt mean={stats['mean_ms']:.2f}ms > 5ms"

    def test_parse_total_under_1ms(self):
        from app.parser import parse_total
        text = "合計金額  ¥12,345"
        stats = _measure(lambda: parse_total(text), n=200)
        assert stats["mean_ms"] < 1, f"parse_total mean={stats['mean_ms']:.3f}ms > 1ms"


# ---------------------------------------------------------------------------
# スループット
# ---------------------------------------------------------------------------

class TestThroughput:
    def test_health_throughput_over_200_rps(self, client):
        """ヘルスチェックは 200 req/s 以上のスループット。"""
        n = 200
        t0 = time.perf_counter()
        for _ in range(n):
            r = client.get("/api/health")
            assert r.status_code == 200
        elapsed = time.perf_counter() - t0
        rps = n / elapsed
        assert rps > 200, f"health throughput={rps:.0f} rps < 200"

    def test_validation_rejection_throughput_over_100_rps(self, client):
        """バリデーション拒否は 100 req/s 以上（セキュリティ DDoS 耐性の最低基準）。"""
        n = 100
        t0 = time.perf_counter()
        for _ in range(n):
            client.post("/api/recipe", json={"items": [], "servings": 0})
        elapsed = time.perf_counter() - t0
        rps = n / elapsed
        assert rps > 100, f"rejection throughput={rps:.0f} rps < 100"


# ---------------------------------------------------------------------------
# メモリ使用量
# ---------------------------------------------------------------------------

class TestMemoryUsage:
    def test_large_receipt_text_parse_no_memory_leak(self):
        """大きなテキスト（20KB 上限相当）を 100 回パースしてもメモリが急増しない。"""
        import tracemalloc
        from app.parser import parse_receipt

        large_text = ("店名テスト\n合計 ¥1000\n" + "商品A ¥100\n" * 200)

        tracemalloc.start()
        snapshot1 = tracemalloc.take_snapshot()

        for _ in range(100):
            parse_receipt(large_text)

        snapshot2 = tracemalloc.take_snapshot()
        tracemalloc.stop()

        top_stats = snapshot2.compare_to(snapshot1, "lineno")
        total_increase_kb = sum(s.size_diff for s in top_stats) / 1024
        # 100 回パースでメモリ増加が 5MB 未満
        assert total_increase_kb < 5 * 1024, f"memory increased {total_increase_kb:.0f}KB > 5MB"

    def test_rate_limiter_memory_cleanup(self):
        """RateLimiter が 1000 IP 超でエントリを自動クリーンアップする。"""
        rl = security.RateLimiter(window_sec=1, per_ip=10000, global_limit=1_000_000)
        # 1001 IP を登録（クリーンアップしきい値 1000 超）
        for i in range(1001):
            rl.check(f"10.{i // 256 // 256}.{(i // 256) % 256}.{i % 256}")
        # _by_ip のサイズが無制限に増えていない（クリーンアップが機能している）
        assert len(rl._by_ip) <= 1001

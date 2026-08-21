"""/api/admin/users のテスト。

Firestore にはユーザー台帳が無いため、登録日時・メールは Firebase
Authentication（auth.list_users）から取り、Firestore の
users/{uid}/settings/subscription と突き合わせてプラン状態を出す。

  - 認証・認可（ADMIN_UIDS 未設定/管理者でない）
  - 名簿とサブスク情報の突き合わせ（uid が subscription 側に無いケース含む）
  - _is_premium が static/stripe-billing.js の isPremium() と同じ判定になること
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

import main
from app.routes import admin as admin_route


@pytest.fixture()
def client(monkeypatch):
    # admin.py は `from app.routes._shared import FIREBASE_PROJECT_ID` で値を
    # コピーしているため、_shared 側をパッチしても admin.py 側は反映されない
    # （import 済みの束縛は独立している）。admin.py 側を直接パッチする。
    monkeypatch.setattr(admin_route, "FIREBASE_PROJECT_ID", "test-project")
    monkeypatch.setattr(admin_route, "ADMIN_UIDS", {"admin-uid"})
    return TestClient(main.app, raise_server_exceptions=False)


def _fake_user(uid, email, created_ms=1000, last_ms=2000):
    return SimpleNamespace(
        uid=uid,
        email=email,
        display_name=None,
        user_metadata=SimpleNamespace(creation_timestamp=created_ms, last_sign_in_timestamp=last_ms),
    )


class TestIsPremium:
    """static/stripe-billing.js の isPremium() と同じ判定になること。"""

    def test_サブスクなしは無料(self):
        assert admin_route._is_premium(None) is False

    def test_betaはactiveなら常にプレミアム(self):
        assert admin_route._is_premium({"plan": "beta", "status": "active"}) is True

    def test_betaでもstatusがactiveでなければ無料(self):
        assert admin_route._is_premium({"plan": "beta", "status": "cancelled"}) is False

    def test_activeで期限未設定はプレミアム(self):
        assert admin_route._is_premium({"plan": "premium", "status": "active"}) is True

    def test_activeでも期限切れなら無料(self, ):
        import time
        past = time.time() - 3600
        assert admin_route._is_premium({"plan": "premium", "status": "active", "currentPeriodEnd": past}) is False

    def test_activeで未来の期限ならプレミアム(self):
        import time
        future = time.time() + 3600
        assert admin_route._is_premium({"plan": "trial", "status": "active", "currentPeriodEnd": future}) is True

    def test_statusがactive以外は無料(self):
        assert admin_route._is_premium({"plan": "premium", "status": "cancelled"}) is False


class TestListRegisteredUsers:
    def test_ADMIN_UIDS未設定なら503(self, client, monkeypatch):
        monkeypatch.setattr(admin_route, "ADMIN_UIDS", set())
        r = client.get("/api/admin/users", headers={"authorization": "Bearer x"})
        assert r.status_code == 503

    def test_管理者でなければ403(self, client):
        with patch("app.security.verify_firebase_token", return_value="not-admin-uid"):
            r = client.get("/api/admin/users", headers={"authorization": "Bearer x"})
        assert r.status_code == 403

    def test_名簿とサブスク状態を突き合わせて返す(self, client):
        users = [
            _fake_user("uid-1", "premium@example.com", created_ms=3000),
            _fake_user("uid-2", "free@example.com", created_ms=1000),
        ]
        page = SimpleNamespace(users=users, next_page_token=None)

        # uid-1 だけ subscription ドキュメントがある想定。
        snap = MagicMock()
        snap.exists = True
        snap.to_dict.return_value = {"plan": "premium", "status": "active"}
        snap.reference.parent.parent.id = "uid-1"

        fake_db = MagicMock()
        fake_db.get_all.return_value = [snap]

        with patch("app.security.verify_firebase_token", return_value="admin-uid"), \
             patch("app.routes.admin._get_firestore", return_value=fake_db), \
             patch.dict(
                 "sys.modules",
                 {"firebase_admin": MagicMock(auth=MagicMock(list_users=MagicMock(return_value=page)))},
             ):
            r = client.get("/api/admin/users", headers={"authorization": "Bearer x"})

        assert r.status_code == 200
        body = r.json()
        assert body["nextPageToken"] is None
        # 新しい登録者（uid-1, createdAt=3000）が先に来る。
        assert [i["uid"] for i in body["items"]] == ["uid-1", "uid-2"]

        u1 = body["items"][0]
        assert u1["email"] == "premium@example.com"
        assert u1["plan"] == "premium"
        assert u1["isPremium"] is True

        u2 = body["items"][1]
        assert u2["plan"] == "free"  # subscription ドキュメントが無いユーザーの既定値
        assert u2["isPremium"] is False

    def test_ユーザー一覧取得失敗は503(self, client):
        fake_auth = MagicMock()
        fake_auth.list_users.side_effect = RuntimeError("boom")
        with patch("app.security.verify_firebase_token", return_value="admin-uid"), \
             patch.dict("sys.modules", {"firebase_admin": MagicMock(auth=fake_auth)}):
            r = client.get("/api/admin/users", headers={"authorization": "Bearer x"})
        assert r.status_code == 503

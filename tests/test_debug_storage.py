"""debug_storage のテスト — バケット名の解決。

initialize_app() に storageBucket を渡していないため、bucket() は必ず
名前を明示して呼ぶ必要がある。その名前解決が壊れると管理者ページの
一覧取得も画像の一時保存も 500 になるので、ここを固定する。
"""
from __future__ import annotations

import pytest

from app import debug_storage


class TestBucketName:
    def test_明示指定があればそれを使う(self, monkeypatch):
        monkeypatch.setenv("FIREBASE_STORAGE_BUCKET", "custom-bucket.appspot.com")
        monkeypatch.setenv("FIREBASE_PROJECT_ID", "expenses-9af61")
        assert debug_storage.bucket_name() == "custom-bucket.appspot.com"

    def test_未指定ならプロジェクトIDから導出する(self, monkeypatch):
        monkeypatch.delenv("FIREBASE_STORAGE_BUCKET", raising=False)
        monkeypatch.setenv("FIREBASE_PROJECT_ID", "expenses-9af61")
        assert debug_storage.bucket_name() == "expenses-9af61.firebasestorage.app"

    def test_空文字の明示指定は無視してプロジェクトIDから導出する(self, monkeypatch):
        monkeypatch.setenv("FIREBASE_STORAGE_BUCKET", "   ")
        monkeypatch.setenv("FIREBASE_PROJECT_ID", "expenses-9af61")
        assert debug_storage.bucket_name() == "expenses-9af61.firebasestorage.app"

    def test_どちらも無ければ原因のわかるエラーにする(self, monkeypatch):
        monkeypatch.delenv("FIREBASE_STORAGE_BUCKET", raising=False)
        monkeypatch.delenv("FIREBASE_PROJECT_ID", raising=False)
        with pytest.raises(RuntimeError, match="FIREBASE_STORAGE_BUCKET"):
            debug_storage.bucket_name()


class TestSaveForDebug:
    def test_無効時は何もしない(self, monkeypatch):
        """RETAIN_ENABLED が False なら Storage に触れない（例外も出さない）。"""
        monkeypatch.setattr(debug_storage, "RETAIN_ENABLED", False)
        debug_storage.save_for_debug(b"x", "image/jpeg", "uid-1")  # 例外が出なければ成功

    def test_保存に失敗してもOCR本処理を止めない(self, monkeypatch):
        """Storage 側が落ちても例外を伝播させない（ベストエフォート）。"""
        monkeypatch.setattr(debug_storage, "RETAIN_ENABLED", True)
        monkeypatch.delenv("FIREBASE_STORAGE_BUCKET", raising=False)
        monkeypatch.delenv("FIREBASE_PROJECT_ID", raising=False)
        debug_storage.save_for_debug(b"x", "image/jpeg", "uid-1")  # 例外が出なければ成功

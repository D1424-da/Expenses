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


@pytest.fixture()
def real_pil(monkeypatch):
    """本物の Pillow を使う。

    tests/test_ocr_engines.py が sys.modules に PIL のモックを差し込むため、
    全体実行時はそのモックを掴んでしまい縮小結果が空になる。
    このテストは実際に縮小できることを確かめたいので本物へ戻す。
    """
    import importlib
    import sys
    # PIL.Image だけ差し替えるとプラグイン（JpegImagePlugin 等）が旧モジュールに
    # 登録されたままになり SAVE が空で KeyError になる。PIL 配下を丸ごと外す。
    for name in [m for m in list(sys.modules) if m == "PIL" or m.startswith("PIL.")]:
        monkeypatch.delitem(sys.modules, name, raising=False)
    pil_image = importlib.import_module("PIL.Image")
    if not hasattr(pil_image, "MEDIANCUT"):  # モックを引き当てていたら検証をやめる
        pytest.skip("本物の Pillow が利用できない環境")
    pil_image.init()  # 画像フォーマットのプラグインを登録する
    return pil_image


class TestThumbnail:
    """一覧プレビュー用の縮小。原寸を並べると転送量が数MB〜十数MBになる。"""

    def _jpeg(self, pil_image, w=1200, h=1600):
        import io
        buf = io.BytesIO()
        pil_image.new("RGB", (w, h), (200, 200, 200)).save(buf, format="JPEG")
        return buf.getvalue()

    def test_指定した最大辺に収まる(self, real_pil):
        from app.routes.admin import _make_thumbnail
        import io
        result = _make_thumbnail(self._jpeg(real_pil), 200)
        assert result is not None
        data, media = result
        assert media == "image/jpeg"
        img = real_pil.open(io.BytesIO(data))
        assert max(img.size) <= 200

    def test_原寸より小さくなる(self, real_pil):
        from app.routes.admin import _make_thumbnail
        original = self._jpeg(real_pil)
        data, _ = _make_thumbnail(original, 200)
        assert len(data) < len(original)

    def test_画像でないデータならNoneを返す(self, real_pil):
        """縮小できなくても原寸を返して表示は継続させる。"""
        from app.routes.admin import _make_thumbnail
        assert _make_thumbnail(b"not an image", 200) is None

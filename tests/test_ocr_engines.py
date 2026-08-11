"""app/ocr.py および app/engines.py のエンジン分岐テスト。

cv2 / pytesseract / PIL / anthropic / google.cloud.vision は
テスト環境に存在しないため sys.modules でモックする。
テストの目的は:
1. OCR_ENGINE 環境変数で正しいエンジン関数が呼ばれること
2. 各エンジン関数が依存ライブラリを正しく使うこと（引数・戻り値の形）
3. engines.extract_with_ai / extract_with_tesseract のフォールバック動作
"""
from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock, patch

import numpy as np
import pytest


# ─────────────────────────────────────────────────────────────────────────────
# cv2 / PIL をモックしてから app.ocr を import する
# ─────────────────────────────────────────────────────────────────────────────

def _make_cv2_mock():
    m = MagicMock()
    m.IMREAD_COLOR = 1
    m.ADAPTIVE_THRESH_GAUSSIAN_C = 1
    m.THRESH_BINARY = 0
    m.INTER_CUBIC = 2
    # デフォルトは有効な 200x100 画像を返す
    m.imdecode.return_value = np.zeros((200, 100, 3), dtype="uint8")
    m.cvtColor.return_value = np.zeros((200, 100), dtype="uint8")
    m.fastNlMeansDenoising.return_value = np.zeros((200, 100), dtype="uint8")
    m.adaptiveThreshold.return_value = np.zeros((200, 100), dtype="uint8")
    m.resize.return_value = np.zeros((1000, 1500, 3), dtype="uint8")
    return m

_cv2_mock = _make_cv2_mock()
_pil_mock = MagicMock()
_pil_image_mock = MagicMock()
_pil_mock.Image = _pil_image_mock

# cv2 / PIL を sys.modules に挿入してから app.ocr をインポート
sys.modules.setdefault("cv2", _cv2_mock)
sys.modules.setdefault("PIL", _pil_mock)
sys.modules.setdefault("PIL.Image", _pil_image_mock)

from app import engines  # noqa: E402 (after mock setup)
import importlib as _importlib  # noqa: E402

# app.ocr はモック済み cv2 を使ってロードされる
import app.ocr as ocr  # noqa: E402

FAKE_JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


@pytest.fixture(autouse=True)
def reset_engine_breaker():
    """各テスト前にサーキットブレーカーをリセットする。

    breaker はプロセス内グローバル（単一インスタンス運用前提）なので、
    リセットしないと 429 を模したテストの失敗が後続テストに漏れる。
    """
    engines.breaker.reset()
    yield
    engines.breaker.reset()


# ─────────────────────────────────────────────────────────────────────────────
# _preprocess
# ─────────────────────────────────────────────────────────────────────────────

class TestPreprocess:
    def test_invalid_bytes_raises(self):
        _cv2_mock.imdecode.return_value = None
        with pytest.raises(ValueError, match="画像を読み込めませんでした"):
            ocr._preprocess(b"not an image")
        # デフォルト値を戻す
        _cv2_mock.imdecode.return_value = np.zeros((200, 100, 3), dtype="uint8")

    def test_valid_jpeg_returns_ndarray(self):
        result = ocr._preprocess(FAKE_JPEG)
        assert result is not None

    def test_small_image_gets_upscaled(self):
        """幅が 1500px 未満の画像は cv2.resize が呼ばれること。"""
        _cv2_mock.imdecode.return_value = np.zeros((100, 300, 3), dtype="uint8")
        _cv2_mock.resize.reset_mock()
        ocr._preprocess(FAKE_JPEG)
        _cv2_mock.resize.assert_called_once()
        new_size = _cv2_mock.resize.call_args[0][1]
        assert new_size[0] >= 1500
        # 元に戻す
        _cv2_mock.imdecode.return_value = np.zeros((200, 100, 3), dtype="uint8")

    def test_large_image_not_resized(self):
        """幅が 1500px 以上の画像は resize されないこと。"""
        _cv2_mock.imdecode.return_value = np.zeros((100, 1600, 3), dtype="uint8")
        _cv2_mock.resize.reset_mock()
        ocr._preprocess(FAKE_JPEG)
        _cv2_mock.resize.assert_not_called()
        _cv2_mock.imdecode.return_value = np.zeros((200, 100, 3), dtype="uint8")


# ─────────────────────────────────────────────────────────────────────────────
# _ocr_tesseract
# ─────────────────────────────────────────────────────────────────────────────

class TestOcrTesseract:
    def _run(self, ocr_text: str = "スーパーA\n合計 500"):
        mock_pytesseract = MagicMock()
        mock_pytesseract.image_to_string.return_value = ocr_text
        with patch.dict(sys.modules, {"pytesseract": mock_pytesseract}):
            return ocr._ocr_tesseract(FAKE_JPEG), mock_pytesseract

    def test_returns_string(self):
        result, _ = self._run("スーパーA\n合計 500")
        assert isinstance(result, str)
        assert "スーパーA" in result

    def test_calls_with_jpn_eng(self):
        _, mock_pt = self._run()
        call_kwargs = str(mock_pt.image_to_string.call_args)
        assert "jpn+eng" in call_kwargs

    def test_uses_psm6_config(self):
        _, mock_pt = self._run()
        call_kwargs = str(mock_pt.image_to_string.call_args)
        assert "--psm 6" in call_kwargs


# ─────────────────────────────────────────────────────────────────────────────
# _ocr_claude
# ─────────────────────────────────────────────────────────────────────────────

class TestOcrClaude:
    def _make_anthropic_mock(self, text: str):
        mock_block = MagicMock()
        mock_block.type = "text"
        mock_block.text = text
        mock_message = MagicMock()
        mock_message.content = [mock_block]
        mock_client = MagicMock()
        mock_client.messages.create.return_value = mock_message
        mock_anthropic = MagicMock()
        mock_anthropic.Anthropic.return_value = mock_client
        return mock_anthropic, mock_client

    def test_returns_text_block_content(self):
        mock_anthropic, _ = self._make_anthropic_mock("イオン\n合計 1000")
        with patch.dict(sys.modules, {"anthropic": mock_anthropic}):
            result = ocr._ocr_claude(FAKE_JPEG)
        assert result == "イオン\n合計 1000"

    def test_ignores_non_text_blocks(self):
        mock_text_block = MagicMock()
        mock_text_block.type = "text"
        mock_text_block.text = "テキスト"
        mock_other_block = MagicMock()
        mock_other_block.type = "tool_use"
        mock_message = MagicMock()
        mock_message.content = [mock_text_block, mock_other_block]
        mock_client = MagicMock()
        mock_client.messages.create.return_value = mock_message
        mock_anthropic = MagicMock()
        mock_anthropic.Anthropic.return_value = mock_client

        with patch.dict(sys.modules, {"anthropic": mock_anthropic}):
            result = ocr._ocr_claude(FAKE_JPEG)
        assert result == "テキスト"

    def test_passes_base64_image(self):
        import base64

        captured = []
        mock_block = MagicMock()
        mock_block.type = "text"
        mock_block.text = "ok"
        mock_message = MagicMock()
        mock_message.content = [mock_block]
        mock_client = MagicMock()
        mock_client.messages.create.side_effect = lambda **kw: (captured.append(kw), mock_message)[1]
        mock_anthropic = MagicMock()
        mock_anthropic.Anthropic.return_value = mock_client

        with patch.dict(sys.modules, {"anthropic": mock_anthropic}):
            ocr._ocr_claude(FAKE_JPEG)

        content = captured[0]["messages"][0]["content"]
        image_part = next(p for p in content if p.get("type") == "image")
        expected = base64.standard_b64encode(FAKE_JPEG).decode("ascii")
        assert image_part["source"]["data"] == expected


# ─────────────────────────────────────────────────────────────────────────────
# _ocr_google
# ─────────────────────────────────────────────────────────────────────────────

class TestOcrGoogle:
    def _make_vision_mock(self, text: str = "西友\n合計 500", error_msg: str = ""):
        mock_annotation = MagicMock()
        mock_annotation.text = text
        mock_response = MagicMock()
        mock_response.full_text_annotation = mock_annotation
        mock_response.error.message = error_msg
        mock_client_inst = MagicMock()
        mock_client_inst.document_text_detection.return_value = mock_response
        mock_vision = MagicMock()
        mock_vision.ImageAnnotatorClient.return_value = mock_client_inst
        return mock_vision

    def test_returns_full_text(self):
        mock_vision = self._make_vision_mock("西友\n合計 500")
        mock_google_cloud = types.ModuleType("google.cloud")
        with patch.dict(sys.modules, {
            "google": MagicMock(), "google.cloud": mock_google_cloud,
            "google.cloud.vision": mock_vision,
        }):
            result = ocr._ocr_google(FAKE_JPEG)
        assert "西友" in result

    def test_raises_on_api_error(self):
        mock_vision = self._make_vision_mock(error_msg="API quota exceeded")
        mock_google_cloud = types.ModuleType("google.cloud")
        with patch.dict(sys.modules, {
            "google": MagicMock(), "google.cloud": mock_google_cloud,
            "google.cloud.vision": mock_vision,
        }):
            with pytest.raises(RuntimeError, match="API quota exceeded"):
                ocr._ocr_google(FAKE_JPEG)


# ─────────────────────────────────────────────────────────────────────────────
# run_ocr — OCR_ENGINE 環境変数による切替
# ─────────────────────────────────────────────────────────────────────────────

class TestRunOcr:
    # _ENGINES dict は定義時に関数参照を保持するため patch.object ではなく
    # patch.dict(ocr._ENGINES, ...) でキー単位に上書きする。
    # 未知エンジンのデフォルト値は run_ocr の `_ENGINES.get(engine, _ocr_tesseract)`
    # の第2引数としてグローバル参照されるため、そちらは patch.object で対応する。

    def test_default_engine_is_tesseract(self, monkeypatch):
        monkeypatch.delenv("OCR_ENGINE", raising=False)
        mock_fn = MagicMock(return_value="tesseract result")
        with patch.dict(ocr._ENGINES, {"tesseract": mock_fn}):
            result = ocr.run_ocr(FAKE_JPEG)
        mock_fn.assert_called_once_with(FAKE_JPEG)
        assert result == "tesseract result"

    def test_ocr_engine_claude(self, monkeypatch):
        monkeypatch.setenv("OCR_ENGINE", "claude")
        mock_fn = MagicMock(return_value="claude result")
        with patch.dict(ocr._ENGINES, {"claude": mock_fn}):
            result = ocr.run_ocr(FAKE_JPEG)
        mock_fn.assert_called_once_with(FAKE_JPEG)
        assert result == "claude result"

    def test_ocr_engine_google(self, monkeypatch):
        monkeypatch.setenv("OCR_ENGINE", "google")
        mock_fn = MagicMock(return_value="google result")
        with patch.dict(ocr._ENGINES, {"google": mock_fn}):
            result = ocr.run_ocr(FAKE_JPEG)
        mock_fn.assert_called_once_with(FAKE_JPEG)
        assert result == "google result"

    def test_unknown_engine_falls_back_to_tesseract(self, monkeypatch):
        monkeypatch.setenv("OCR_ENGINE", "nonexistent")
        with patch.object(ocr, "_ocr_tesseract", return_value="fallback") as mock_t:
            result = ocr.run_ocr(FAKE_JPEG)
        mock_t.assert_called_once()
        assert result == "fallback"

    def test_engine_env_case_insensitive(self, monkeypatch):
        # 「CLAUDE」→ .lower() → "claude" でキーが一致すること
        monkeypatch.setenv("OCR_ENGINE", "CLAUDE")
        mock_fn = MagicMock(return_value="upper claude")
        with patch.dict(ocr._ENGINES, {"claude": mock_fn}):
            result = ocr.run_ocr(FAKE_JPEG)
        mock_fn.assert_called_once()
        assert result == "upper claude"


# ─────────────────────────────────────────────────────────────────────────────
# engines.extract_with_ai — フォールバック動作
# ─────────────────────────────────────────────────────────────────────────────

class TestExtractWithAiFallback:
    def test_preferred_engine_called_first(self):
        mock_gemini = MagicMock()
        mock_gemini.extract_receipt.return_value = {"amount": 100, "engine": "gemini"}
        mock_vertex = MagicMock()

        with patch.object(engines, "gemini", mock_gemini), \
             patch.object(engines, "vertex", mock_vertex):
            result = engines.extract_with_ai("gemini", FAKE_JPEG)

        mock_gemini.extract_receipt.assert_called_once()
        mock_vertex.extract_receipt.assert_not_called()
        assert result["engine"] == "gemini"

    def test_falls_back_to_vertex_when_gemini_fails(self):
        mock_gemini = MagicMock()
        mock_gemini.extract_receipt.side_effect = RuntimeError("quota exceeded")
        mock_vertex = MagicMock()
        mock_vertex.extract_receipt.return_value = {"amount": 200, "engine": "vertex"}

        with patch.object(engines, "gemini", mock_gemini), \
             patch.object(engines, "vertex", mock_vertex):
            result = engines.extract_with_ai("gemini", FAKE_JPEG)

        mock_gemini.extract_receipt.assert_called_once()
        mock_vertex.extract_receipt.assert_called_once()
        assert result["engine"] == "vertex"

    def test_falls_back_to_vision_when_all_ai_fail(self, monkeypatch):
        monkeypatch.setenv("VISION_API_KEY", "fake-vision-key")
        mock_gemini = MagicMock()
        mock_gemini.extract_receipt.side_effect = RuntimeError("gemini fail")
        mock_vertex = MagicMock()
        mock_vertex.extract_receipt.side_effect = RuntimeError("vertex fail")
        mock_vision = MagicMock()
        mock_vision.extract_receipt.return_value = {"amount": 300}

        with patch.object(engines, "gemini", mock_gemini), \
             patch.object(engines, "vertex", mock_vertex), \
             patch.object(engines, "vision", mock_vision):
            result = engines.extract_with_ai("gemini", FAKE_JPEG)

        mock_vision.extract_receipt.assert_called_once()
        assert result["engine"] == "vision"

    def test_raises_extraction_error_when_all_fail(self, monkeypatch):
        monkeypatch.delenv("VISION_API_KEY", raising=False)
        mock_gemini = MagicMock()
        mock_gemini.extract_receipt.side_effect = RuntimeError("gemini fail")
        mock_vertex = MagicMock()
        mock_vertex.extract_receipt.side_effect = RuntimeError("vertex fail")

        with patch.object(engines, "gemini", mock_gemini), \
             patch.object(engines, "vertex", mock_vertex), \
             patch.object(engines, "vision", None):
            with pytest.raises(engines.ExtractionError):
                engines.extract_with_ai("gemini", FAKE_JPEG)

    def test_vertex_preferred_skips_gemini(self):
        mock_gemini = MagicMock()
        mock_vertex = MagicMock()
        mock_vertex.extract_receipt.return_value = {"amount": 500, "engine": "vertex"}

        with patch.object(engines, "gemini", mock_gemini), \
             patch.object(engines, "vertex", mock_vertex):
            result = engines.extract_with_ai("vertex", FAKE_JPEG)

        mock_vertex.extract_receipt.assert_called_once()
        mock_gemini.extract_receipt.assert_not_called()

    def test_none_module_is_skipped(self):
        mock_vertex = MagicMock()
        mock_vertex.extract_receipt.return_value = {"amount": 600, "engine": "vertex"}

        with patch.object(engines, "gemini", None), \
             patch.object(engines, "vertex", mock_vertex):
            result = engines.extract_with_ai("gemini", FAKE_JPEG)

        mock_vertex.extract_receipt.assert_called_once()
        assert result["engine"] == "vertex"

    def test_passes_content_type_to_engine(self):
        mock_gemini = MagicMock()
        mock_gemini.extract_receipt.return_value = {"amount": 0}

        with patch.object(engines, "gemini", mock_gemini), \
             patch.object(engines, "vertex", None):
            engines.extract_with_ai("gemini", FAKE_JPEG, "image/png")

        mock_gemini.extract_receipt.assert_called_once_with(FAKE_JPEG, "image/png")


# ─────────────────────────────────────────────────────────────────────────────
# engines.extract_with_tesseract
# ─────────────────────────────────────────────────────────────────────────────

class TestExtractWithTesseract:
    def test_calls_run_ocr_and_parse_receipt(self):
        with patch("app.ocr.run_ocr", return_value="イオン\n合計 500") as mock_ocr, \
             patch("app.parser.parse_receipt", return_value={"store": "イオン", "amount": 500}) as mock_parse:
            result = engines.extract_with_tesseract(FAKE_JPEG)

        mock_ocr.assert_called_once_with(FAKE_JPEG)
        mock_parse.assert_called_once_with("イオン\n合計 500")
        assert result["engine"] == "tesseract"
        assert result["store"] == "イオン"

    def test_engine_field_added(self):
        with patch("app.ocr.run_ocr", return_value=""), \
             patch("app.parser.parse_receipt", return_value={"amount": 0}):
            result = engines.extract_with_tesseract(FAKE_JPEG)
        assert result["engine"] == "tesseract"

"""app/recipe.suggest_recipes と app/gemini.extract_receipt のモック統合テスト。

テストの目的:
1. suggest_recipes が正しいプロンプトを組み立てて net.post_json を呼ぶこと
2. suggest_recipes がレスポンスからテキストを取り出して返すこと
3. GEMINI_API_KEY なし → GOOGLE_CLOUD_PROJECT の Vertex へフォールバックすること
4. 両方なし → RuntimeError を投げること
5. extract_receipt が正しいリクエストボディを組み立てること
6. extract_receipt が GEMINI_API_KEY なしで RuntimeError を投げること
7. build_request_body / parse_generate_content のプロンプト・JSON 解析ロジック
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, call, patch

import pytest

from app import gemini, recipe


# ─────────────────────────────────────────────────────────────────────────────
# ヘルパー
# ─────────────────────────────────────────────────────────────────────────────

def _make_generate_response(text: str) -> dict:
    """generateContent の成功レスポンスを組み立てる。"""
    return {"candidates": [{"content": {"parts": [{"text": text}]}}]}


# ─────────────────────────────────────────────────────────────────────────────
# app/gemini.py — build_request_body
# ─────────────────────────────────────────────────────────────────────────────

class TestBuildRequestBody:
    def test_contains_image_and_prompt(self):
        body = gemini.build_request_body("BASE64DATA==", "image/jpeg")
        contents = body["contents"][0]
        parts = contents["parts"]
        types = [p.get("inline_data", {}).get("mime_type") if "inline_data" in p else p.get("text") for p in parts]
        assert "image/jpeg" in types
        assert any(isinstance(t, str) and "JSON" in t for t in types)

    def test_role_is_user(self):
        body = gemini.build_request_body("B64==")
        assert body["contents"][0]["role"] == "user"

    def test_temperature_zero(self):
        body = gemini.build_request_body("B64==")
        assert body["generationConfig"]["temperature"] == 0

    def test_response_mime_type_json(self):
        body = gemini.build_request_body("B64==")
        assert body["generationConfig"]["response_mime_type"] == "application/json"

    def test_custom_content_type(self):
        body = gemini.build_request_body("B64==", "image/png")
        parts = body["contents"][0]["parts"]
        mime = next(p["inline_data"]["mime_type"] for p in parts if "inline_data" in p)
        assert mime == "image/png"

    def test_b64_data_in_inline_data(self):
        body = gemini.build_request_body("MYDATA==")
        parts = body["contents"][0]["parts"]
        data = next(p["inline_data"]["data"] for p in parts if "inline_data" in p)
        assert data == "MYDATA=="


# ─────────────────────────────────────────────────────────────────────────────
# app/gemini.py — extract_receipt
# ─────────────────────────────────────────────────────────────────────────────

FAKE_JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64

class TestExtractReceiptGemini:
    def test_raises_without_api_key(self, monkeypatch):
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
            gemini.extract_receipt(FAKE_JPEG)

    def test_calls_post_json_with_api_key_in_url(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "my-test-key")
        response_text = json.dumps({
            "date": "2025-06-15", "store": "テストスーパー", "branch": "新宿店",
            "total": 1500, "category": "食費", "items": [],
        })
        with patch("app.net.post_json", return_value=_make_generate_response(response_text)) as mock_post:
            result = gemini.extract_receipt(FAKE_JPEG)

        url_called = mock_post.call_args[0][0]
        assert "my-test-key" in url_called
        assert "generateContent" in url_called

    def test_returns_normalized_dict(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "key123")
        response_text = json.dumps({
            "date": "2025-06-15", "store": "イオン", "branch": "南店",
            "total": 2000, "category": "食費",
            "items": [{"name": "牛乳", "price": 200, "category": "食費"}],
        })
        with patch("app.net.post_json", return_value=_make_generate_response(response_text)):
            result = gemini.extract_receipt(FAKE_JPEG)

        assert result["store"] == "イオン"
        assert result["branch"] == "南店"
        assert result["amount"] == 2000
        assert result["date"] == "2025-06-15"
        assert result["engine"] == "gemini"
        assert len(result["items"]) == 1
        assert result["items"][0]["name"] == "牛乳"

    def test_passes_base64_image_in_body(self, monkeypatch):
        import base64

        monkeypatch.setenv("GEMINI_API_KEY", "key")
        captured_bodies = []
        with patch("app.net.post_json",
                   side_effect=lambda url, body, **kw: (captured_bodies.append(body), _make_generate_response("{}"))[1]):
            try:
                gemini.extract_receipt(FAKE_JPEG)
            except Exception:
                pass

        expected_b64 = base64.standard_b64encode(FAKE_JPEG).decode("ascii")
        body = captured_bodies[0]
        parts = body["contents"][0]["parts"]
        img_data = next(p["inline_data"]["data"] for p in parts if "inline_data" in p)
        assert img_data == expected_b64

    def test_malformed_json_response_still_returns_dict(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        with patch("app.net.post_json", return_value=_make_generate_response("not json at all")):
            result = gemini.extract_receipt(FAKE_JPEG)
        # normalize_receipt が {} に対してデフォルト値を埋める
        assert "amount" in result
        assert result["engine"] == "gemini"


# ─────────────────────────────────────────────────────────────────────────────
# app/recipe.py — suggest_recipes
# ─────────────────────────────────────────────────────────────────────────────

RECIPE_RESPONSE = "## 肉じゃが\n**難易度**: ★☆☆\n**調理時間**: 約30分\n..."

class TestSuggestRecipes:
    def _mock_post_json(self, text: str = RECIPE_RESPONSE):
        return patch("app.net.post_json", return_value=_make_generate_response(text))

    def test_raises_without_any_credentials(self, monkeypatch):
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
        monkeypatch.delenv("VERTEX_PROJECT", raising=False)
        with pytest.raises(RuntimeError):
            recipe.suggest_recipes(["卵", "牛乳"], 2)

    def test_uses_gemini_api_key_when_set(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "my-gemini-key")
        with self._mock_post_json() as mock_post:
            result = recipe.suggest_recipes(["卵", "牛乳"], 2)
        url = mock_post.call_args[0][0]
        assert "generativelanguage.googleapis.com" in url
        assert "my-gemini-key" in url or mock_post.call_args[1].get("headers", {}).get("x-goog-api-key") == "my-gemini-key"

    def test_returns_text_string(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        with self._mock_post_json(RECIPE_RESPONSE):
            result = recipe.suggest_recipes(["豚肉", "じゃがいも"], 4)
        assert isinstance(result, str)
        assert len(result.strip()) > 0

    def test_items_appear_in_prompt(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        captured = []
        def capture(url, body, **kw):
            captured.append(body)
            return _make_generate_response(RECIPE_RESPONSE)

        with patch("app.net.post_json", side_effect=capture):
            recipe.suggest_recipes(["鶏肉", "玉ねぎ", "にんじん"], 3)

        prompt = captured[0]["contents"][0]["parts"][0]["text"]
        assert "鶏肉" in prompt
        assert "玉ねぎ" in prompt
        assert "にんじん" in prompt

    def test_servings_appear_in_prompt(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        captured = []
        def capture(url, body, **kw):
            captured.append(body)
            return _make_generate_response(RECIPE_RESPONSE)

        with patch("app.net.post_json", side_effect=capture):
            recipe.suggest_recipes(["卵"], 5)

        prompt = captured[0]["contents"][0]["parts"][0]["text"]
        assert "5" in prompt

    def test_recipe_type_meal_is_default(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        captured = []
        def capture(url, body, **kw):
            captured.append(body)
            return _make_generate_response(RECIPE_RESPONSE)

        with patch("app.net.post_json", side_effect=capture):
            recipe.suggest_recipes(["卵", "牛乳"], 2)

        prompt = captured[0]["contents"][0]["parts"][0]["text"]
        # meal プロンプトには「2〜3品提案」が含まれる
        assert "2〜3品" in prompt

    def test_recipe_type_weekly(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        captured = []
        def capture(url, body, **kw):
            captured.append(body)
            return _make_generate_response(RECIPE_RESPONSE)

        with patch("app.net.post_json", side_effect=capture):
            recipe.suggest_recipes(["野菜", "肉"], 4, recipe_type="weekly", days=5)

        prompt = captured[0]["contents"][0]["parts"][0]["text"]
        # weekly プロンプトには「献立」が含まれる
        assert "献立" in prompt
        assert "5" in prompt  # 指定日数

    def test_recipe_type_select(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        captured = []
        def capture(url, body, **kw):
            captured.append(body)
            return _make_generate_response(RECIPE_RESPONSE)

        with patch("app.net.post_json", side_effect=capture):
            recipe.suggest_recipes(["卵"], 2, recipe_type="select")

        prompt = captured[0]["contents"][0]["parts"][0]["text"]
        # select プロンプトには「朝食・昼食��夕食」が含まれる
        assert "朝食" in prompt and "昼食" in prompt and "夕食" in prompt

    def test_max_minutes_note_added(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        captured = []
        def capture(url, body, **kw):
            captured.append(body)
            return _make_generate_response(RECIPE_RESPONSE)

        with patch("app.net.post_json", side_effect=capture):
            recipe.suggest_recipes(["卵"], 2, max_minutes=20)

        prompt = captured[0]["contents"][0]["parts"][0]["text"]
        assert "20" in prompt

    def test_use_up_note_added(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        captured = []
        def capture(url, body, **kw):
            captured.append(body)
            return _make_generate_response(RECIPE_RESPONSE)

        with patch("app.net.post_json", side_effect=capture):
            recipe.suggest_recipes(["卵", "牛乳"], 2, use_up=True)

        prompt = captured[0]["contents"][0]["parts"][0]["text"]
        assert "使い切" in prompt

    def test_family_note_added(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        captured = []
        def capture(url, body, **kw):
            captured.append(body)
            return _make_generate_response(RECIPE_RESPONSE)

        with patch("app.net.post_json", side_effect=capture):
            recipe.suggest_recipes(
                ["卵"], 3,
                family={"adults_m": 1, "adults_f": 1, "toddlers": 1},
            )

        prompt = captured[0]["contents"][0]["parts"][0]["text"]
        assert "幼児" in prompt

    def test_empty_response_raises(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        with patch("app.net.post_json", return_value=_make_generate_response("   ")):
            with pytest.raises(RuntimeError, match="レシピを生成できませんでした"):
                recipe.suggest_recipes(["卵"], 2)

    def test_api_error_falls_back_to_vertex(self, monkeypatch):
        """Gemini API エラー時に Vertex AI へフォールバックすること。"""
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "my-project")

        call_count = [0]
        def side_effect(url, body, **kw):
            call_count[0] += 1
            if "generativelanguage.googleapis.com" in url:
                raise RuntimeError("Gemini API down")
            return _make_generate_response(RECIPE_RESPONSE)

        mock_token = patch("app.vertex._get_access_token", return_value="fake-token")
        with patch("app.net.post_json", side_effect=side_effect), mock_token:
            result = recipe.suggest_recipes(["卵"], 2)

        assert call_count[0] >= 2  # Gemini 1回 + Vertex 1回以上
        assert isinstance(result, str)

    def test_temperature_is_07(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        captured = []
        def capture(url, body, **kw):
            captured.append(body)
            return _make_generate_response(RECIPE_RESPONSE)

        with patch("app.net.post_json", side_effect=capture):
            recipe.suggest_recipes(["卵"], 2)

        assert captured[0]["generationConfig"]["temperature"] == 0.7


# ─────────────────────────────────────────────────────────────────────────────
# app/recipe.py — _family_note
# ─────────────────────────────────────────────────────────────────────────────

class TestFamilyNote:
    def test_empty_dict_returns_empty(self):
        assert recipe._family_note({}) == ""

    def test_none_returns_empty(self):
        assert recipe._family_note(None) == ""

    def test_adults_m_included(self):
        note = recipe._family_note({"adults_m": 2})
        assert "大人（男）2人" in note

    def test_all_members_included(self):
        note = recipe._family_note({
            "adults_m": 1, "adults_f": 1,
            "toddlers": 1, "elementary": 2, "junior_high": 1,
        })
        assert "大人（男）1人" in note
        assert "大人（女）1人" in note
        assert "幼児1人" in note
        assert "小学生2人" in note
        assert "中学生・高校生1人" in note

    def test_zero_counts_not_included(self):
        note = recipe._family_note({"adults_m": 0, "adults_f": 1})
        assert "大人（男）" not in note
        assert "大人（女）1人" in note


# ─────────────────────────────────────────────────────────────────────────────
# app/recipe.py — days 上下限クランプ
# ─────────────────────────────────────────────────────────────────────────────

class TestWeeklyDays:
    def _capture_prompt(self, days, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "key")
        captured = []
        def capture(url, body, **kw):
            captured.append(body)
            return _make_generate_response(RECIPE_RESPONSE)
        with patch("app.net.post_json", side_effect=capture):
            recipe.suggest_recipes(["野菜"], 2, recipe_type="weekly", days=days)
        return captured[0]["contents"][0]["parts"][0]["text"]

    def test_days_1_prompt_contains_monday(self, monkeypatch):
        # days=1 → day_labels に「月曜日」だけが入ること
        # テンプレート末尾の例示行に「火曜日」が含まれるため、
        # day_labels の中身だけを確認する
        prompt = self._capture_prompt(1, monkeypatch)
        # 「最大1日分の献立を提案」という文字列でクランプ確認
        assert "最大1日分" in prompt
        assert "月曜日" in prompt

    def test_days_clamped_to_7_maximum(self, monkeypatch):
        prompt = self._capture_prompt(10, monkeypatch)
        assert "日曜日" in prompt

    def test_days_5(self, monkeypatch):
        prompt = self._capture_prompt(5, monkeypatch)
        assert "金曜日" in prompt
        assert "土曜日" not in prompt

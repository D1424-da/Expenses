"""scripts/scan_secrets.py の検査。

この検査が守っているのは2つ。

1. **本物を見逃さない** — 2026-06 に実際に漏れた形（`AIza` で始まる Gemini の
   キー）を検出できること。
2. **公開前提の値で騒がない** — Firebase の `apiKey` は隠せない値なので、
   ここで落ちると開発者が検査自体を無効にする。**同じ値・同じファイルでも
   `apiKey:` は通し、`GEMINI_API_KEY` は止める**のが要点。

値そのものをテストに書かないため、`AIza` + 35文字の合成値を使う。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import scan_secrets as ss  # noqa: E402

# 本物ではない。形だけ合わせた合成値。
#
# **連結で組み立てているのは意図的。** リテラルとして1つの文字列に書くと、
# GitHub の push protection が本物と判定して push 自体を弾く（実際に弾かれた）。
# 検査対象の形をテストに書く以上、この回避は避けられない。
def _synth(prefix: str, body: str) -> str:
    """秘密情報の形をした合成値を、ファイル上に連続した literal を残さず作る。"""
    return prefix + body


FAKE_GOOGLE = _synth("AIza", "Sy0Bd9zXqW3mNp7Lk2Rt5Vh8Jc4Fg6Ye1Qa")
FAKE_STRIPE = _synth("sk_" + "live_", "51QhZ8mKp3nRt7VwXyB2cDeF4")
FAKE_WHSEC  = _synth("wh" + "sec_", "a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuV")
FAKE_GHP    = _synth("gh" + "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")
FAKE_AWS    = _synth("AK" + "IA", "IOSFODNN7EXAMPL1")
FAKE_SLACK  = _synth("xo" + "xb-", "1234567890-abcdefghij")


def test_合成値の長さが本物と同じ形である():
    # 前提が崩れると以降のテストが無意味になるので固定する。
    assert len(FAKE_GOOGLE) == 39


@pytest.mark.parametrize("kind,line", [
    ("Google API キー",      f'export const GEMINI_API_KEY = "{FAKE_GOOGLE}";'),
    ("Stripe 本番キー",       f'STRIPE_SECRET_KEY = "{FAKE_STRIPE}"'),
    ("Stripe Webhook 署名鍵", f'wh = "{FAKE_WHSEC}"'),
    ("GitHub トークン",       f'tok = "{FAKE_GHP}"'),
    ("AWS アクセスキー",      f'aws = "{FAKE_AWS}"'),
    ("Slack トークン",        f'slack = "{FAKE_SLACK}"'),
    ("秘密鍵ファイル",        "-----BEGIN PRIVATE KEY-----"),
    ("資格情報つき接続URL",   'DB = "postgres://admin:h7Kp2mQx@db.internal:5432/app"'),
])
def test_既知の形を検出する(kind, line):
    hits = ss.scan_line("static/app.js", line)
    assert kind in [k for k, _ in hits], f"{kind} を検出できていない: {hits}"


def test_値そのものは出力しない():
    hits = ss.scan_line("static/app.js", f'const k = "{FAKE_GOOGLE}";')
    assert hits
    for _, hint in hits:
        assert FAKE_GOOGLE not in hint
        # 先頭4文字と長さだけ。残りは復元できない。
        assert hint.startswith("AIza")
        assert "39" in hint
        assert FAKE_GOOGLE[4:] not in hint


@pytest.mark.parametrize("line", [
    f'apiKey: "{FAKE_GOOGLE}"  // dummy',
    'GEMINI_API_KEY = "your-api-key-here"',
    'key = os.environ.get("GEMINI_API_KEY")',
    'const k = process.env.GEMINI_API_KEY;',
    'FIREBASE_TOKEN: ${{ secrets.FIREBASE_TOKEN }}',
    'apiKey: "<YOUR_KEY>"',
    'password = "changeme-please"',
])
def test_設定例やプレースホルダは飛ばす(line):
    # 落ちると検査そのものが無効化されるので、静かにすることも要件。
    assert ss.scan_line("docs/setup.md", line) == []


class Test_Firebaseのapikeyは秘密ではない:
    """`AIza` で始まるので混同しやすいが、公開前提の値。消すと動かなくなる。"""

    def test_firebase_configのapikey行は通す(self):
        line = f'  apiKey: "{FAKE_GOOGLE}",'
        assert ss.scan_line("static/firebase-config.js", line) == []

    def test_同じファイルでもgemini側は止める(self):
        # 2026-06 の事故はこれ。同じ値を両方に使っていた。
        line = f'export const GEMINI_API_KEY = "{FAKE_GOOGLE}";'
        assert ss.scan_line("static/firebase-config.js", line) != []

    def test_他のファイルのapikeyは通さない(self):
        # 用途ごとにキーを分ける決まりなので、他所に出ること自体が間違い。
        line = f'  apiKey: "{FAKE_GOOGLE}",'
        assert ss.scan_line("static/app.js", line) != []


def test_追跡中のファイルに秘密情報が無い():
    """いまのリポジトリが綺麗であることを固定する。

    これが落ちたら、秘密情報を含むコミットが入ったということ。
    まず発行元で無効化してから、コードを直す。
    """
    root = Path(__file__).resolve().parents[1]
    r = subprocess.run(
        [sys.executable, "scripts/scan_secrets.py"],
        cwd=root, capture_output=True, text=True,
    )
    assert r.returncode == 0, f"秘密情報が見つかった:\n{r.stderr}"


def test_見つからないときも限界を明示する():
    # 「見つからなかった」を「無い」と読ませないため。
    root = Path(__file__).resolve().parents[1]
    r = subprocess.run(
        [sys.executable, "scripts/scan_secrets.py"],
        cwd=root, capture_output=True, text=True,
    )
    assert "見つけられない" in r.stdout


# ── 2026-09-02 に実地で見つかった2つの欠陥 ────────────────────────────
#
# マージ前の検査で、この2つのために **正しい変更が NG になった**。
# 落ちる検査は無効化されるので、静かにすることも要件のうち。


class Test_非ASCIIのファイル名:
    """git は非ASCII名を引用符つき・8進エスケープで書く。

    素朴に `+++ b/` の6文字を落とす実装だと path が取れず、
    **ALLOW（パスで判定する）が黙って効かなくなる。**
    このリポジトリは docs/ を日本語名にしているので必ず通る経路。
    """

    def test_引用符つきの日本語パスを復元する(self):
        line = r'+++ "b/docs/\344\275\234\346\245\255\345\202\231\345\277\230\351\214\262.md"'
        assert ss._diff_path(line) == "docs/作業備忘録.md"

    def test_ふつうのパスはそのまま(self):
        assert ss._diff_path("+++ b/static/app.js") == "static/app.js"

    def test_日本語パスでも_ALLOW_が効く(self):
        # path が "?" のままだと、この判定に到達できない。
        line = r'+++ "b/static/firebase-config.js"'
        assert ss._diff_path(line) == "static/firebase-config.js"
        assert ss.scan_line(ss._diff_path(line), f'  apiKey: "{FAKE_GOOGLE}",') == []


class Test_ドキュメントによる形の引用:
    """検査の説明そのものが秘密鍵のヘッダ表記を含み、自分の説明で NG になった。"""

    def test_mdのバッククォート内の引用は通す(self):
        line = "`AKIA` / `xox[baprs]-` / `-----BEGIN PRIVATE KEY-----` / 資格情報つきの"
        assert ss.scan_line("docs/memo.md", line) == []

    def test_mdでも素で貼られていれば止める(self):
        assert ss.scan_line("docs/memo.md", "-----BEGIN PRIVATE KEY-----") != []

    def test_md以外では引用でも止める(self):
        # コードにバッククォートで囲んで書く動機が無いので、緩めない。
        line = "// `-----BEGIN PRIVATE KEY-----`"
        assert ss.scan_line("static/app.js", line) != []

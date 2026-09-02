"""リポジトリ内のスクリプトが、書いた本人の1台以外でも動くことの検証。

`build_blog.py` は `STATIC = Path("/home/user/Expenses/static")` と
絶対パスを埋め込んでいた。**`CLAUDE.md` のコマンド一覧に載っているのに、
その1台以外では `FileNotFoundError` で落ちる**状態だった。CI でも走らない
（`test.yml` は pytest と vitest だけ）ので、2026-09-02 にデプロイ前の
検証で実行するまで誰も気づかなかった。

同じ埋め込みが `fix_article_ids.py` / `add_related_nav.py` /
`fix_factcheck.py` にもあった。

これから予定している作業——sitemap の `lastmod` 補完、カテゴリの整理、
`blog.html` の見出し変更——はすべて `build_blog.py` を通すので、
壊れたままだと着手できない。
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

# 他人の環境には存在しないパスの形。
ABSOLUTE_HOME = re.compile(
    r"""["'](?:/home/[^/"']+/|/Users/[^/"']+/|[A-Za-z]:\\\\Users\\\\)""",
)


def _py_sources() -> list[Path]:
    """リポジトリ管理下の Python ソース。"""
    out = subprocess.run(
        ["git", "ls-files", "*.py"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.split()
    return [ROOT / p for p in out]


def test_python_sources_exist():
    assert len(_py_sources()) > 10


def _cited(line: str, match: str) -> bool:
    """その行で、バッククォートに囲まれた引用として現れているか。

    直した経緯を docstring に残すと、**説明が検査に引っかかる**。
    実際にこのファイルの docstring で落ちた（コミットして追跡された
    瞬間に `git ls-files` に入り、自分を検査対象にした）。

    Python にバッククォートの構文は無いので、囲まれていれば必ず説明。
    逆に**素で書かれた絶対パスは囲まれないので止まる** —
    `scripts/scan_secrets.py` の `_cited_in_docs()` と同じ考え方。
    """
    return any(match in m.group(1) for m in re.finditer(r"`([^`]*)`", line))


def test_no_hardcoded_home_paths():
    """個人のホームディレクトリを指す絶対パスを埋め込まない。

    パスは `Path(__file__).resolve().parent` から解決する。
    """
    offenders = []
    for path in _py_sources():
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue                      # 行コメントでの説明は対象外
            m = ABSOLUTE_HOME.search(line)
            if m and not _cited(line, m.group(0)):
                offenders.append(f"{path.relative_to(ROOT)}:{n}")
    assert not offenders, (
        "個人のホームを指す絶対パスが埋め込まれている: " + ", ".join(offenders)
    )


def test_citation_rule_still_catches_real_code(tmp_path: Path):
    """引用の除外が、素で書かれた絶対パスまで通してしまわないこと。

    ここが緩むと検査が形だけになる。
    """
    # 連結で組み立てる。リテラルとして1行に書くと、**この検体自身が
    # test_no_hardcoded_home_paths に引っかかる**（実際に落ちた）。
    # 検査対象の形をテストに書く以上、この回避は避けられない
    # （tests/test_scan_secrets.py の _synth() と同じ事情）。
    bad = 'STATIC = Path("' + '/home/' + 'user/Expenses/static")'
    m = ABSOLUTE_HOME.search(bad)
    assert m is not None
    assert not _cited(bad, m.group(0)), "素のコードを引用と誤判定している"
    quoted = f"`{bad}` と書いていた"
    assert _cited(quoted, ABSOLUTE_HOME.search(quoted).group(0))


@pytest.mark.parametrize("script", ["build_blog.py", "add_related_nav.py",
                                    "fix_article_ids.py", "fix_factcheck.py"])
def test_script_resolves_paths_from_its_own_location(script: str):
    """パスの起点が `__file__` であること。"""
    src = (ROOT / script).read_text(encoding="utf-8")
    assert "Path(__file__).resolve().parent" in src, (
        f"{script} が自身の位置からパスを解決していない"
    )


def test_build_blog_runs_from_any_cwd(tmp_path: Path):
    """`build_blog.py` が cwd に依存せず走ること。

    絶対パスの埋め込みだけでなく、相対パス（`Path("static")`）へ直したときも
    ここで落ちる。CLAUDE.md は cwd を指定せずコマンドを載せている。
    """
    r = subprocess.run(
        [sys.executable, str(ROOT / "build_blog.py")],
        cwd=tmp_path, capture_output=True, text=True,
    )
    assert r.returncode == 0, f"リポジトリ外の cwd で落ちた:\n{r.stderr[-800:]}"
    assert "sitemap.xml" in r.stdout


def test_build_blog_output_is_current():
    """再生成しても生成物が変わらないこと。

    差分が出るなら、`articles.json` を触ったあとに `build_blog.py` を
    流し忘れている（一覧・カテゴリ・サイトマップが実態とずれる）。
    """
    subprocess.run([sys.executable, str(ROOT / "build_blog.py")],
                   cwd=ROOT, capture_output=True, text=True, check=True)
    changed = subprocess.run(
        ["git", "status", "--porcelain", "--", "static/"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout.splitlines()
    modified = [l for l in changed if not l.startswith("??")]
    assert not modified, (
        "build_blog.py の生成物が最新でない（再生成して commit すること）:\n"
        + "\n".join(modified)
    )

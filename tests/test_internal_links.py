"""サイト内リンクが行き止まりになっていないかの検証。

Search Console のパンくずレポートをきっかけに全156ページを検査したところ、
次の4種類の不整合が見つかった。いずれも「リンク自体は表示されるが、
辿った先が意図しないページになる」もので、目視では気づけない。

  1. /blog/cat/lifestyle.html （記事0本のカテゴリ）… 13ページから参照
     カテゴリページは記事があるものだけ生成されるのに、ナビは
     NAV_CATEGORIES を全件並べていた。
  2. /blog/（末尾スラッシュ）… 18ページ＋パンくず30件から参照
     firebase.json の rewrite は "/blog" だけ。"/blog/" は "**" に
     マッチして noindex の login.html が返る。
  3. /index.html#pricing … 33ページから参照
     firebase.json で "/" に 301 される。毎回リダイレクトを1回はさむ。
  4. 統合済み記事への直リンク … 5ページから参照
     301 で別記事へ飛ぶため、リンクを1回無駄にしている。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
BASE_URL = "https://get-tohon.online"

# 外部・特殊スキーム
_SKIP_PREFIX = ("mailto:", "tel:", "javascript:", "data:")


def _config() -> dict:
    return json.loads((ROOT / "firebase.json").read_text(encoding="utf-8"))


def _pages() -> list[Path]:
    return sorted(STATIC.rglob("*.html"))


def _internal_hrefs(path: Path):
    """ページ内のサイト内リンクをパス（フラグメント除去済み）で返す。"""
    html = path.read_text(encoding="utf-8")
    for href in sorted(set(re.findall(r'href="([^"]+)"', html))):
        if href.startswith(_SKIP_PREFIX) or href.startswith("#"):
            continue
        if href.startswith("http"):
            if not href.startswith(BASE_URL):
                continue                       # 外部サイトは対象外
            href = href[len(BASE_URL):] or "/"
        if not href.startswith("/"):
            continue                           # 相対リンクは使っていない
        clean = href.split("#")[0].split("?")[0]
        if clean:
            yield clean


def test_pages_exist():
    assert len(_pages()) > 100


def test_no_link_falls_through_to_login():
    """実在しないパスへのリンクが無い。

    firebase.json の "**" → /login.html により、存在しない URL は
    noindex, nofollow の LP が返る。404 にならないぶん気づきにくい。
    """
    cfg = _config()
    rewrites = {r["source"] for r in cfg["hosting"]["rewrites"]}
    redirects = {r["source"] for r in cfg["hosting"]["redirects"]}

    problems = []
    for page in _pages():
        for path in _internal_hrefs(page):
            if path in rewrites or path in redirects:
                continue
            target = STATIC / (path.lstrip("/") or "index.html")
            if not target.is_file():
                problems.append(f"{page.relative_to(STATIC)} → {path}")
    assert not problems, (
        "実在しないURLへのリンク: " + "; ".join(sorted(set(problems))[:10])
    )


def test_no_link_to_redirected_url():
    """301 される URL へリンクしない。

    リダイレクトを1回はさむぶんクロールを無駄にする。
    最初から最終地点を指す。
    """
    redirects = {r["source"]: r["destination"] for r in _config()["hosting"]["redirects"]}

    problems = []
    for page in _pages():
        for path in _internal_hrefs(page):
            if path in redirects:
                problems.append(
                    f"{page.relative_to(STATIC)} → {path}（{redirects[path]} へ301）"
                )
    assert not problems, "301される URL へのリンク: " + "; ".join(sorted(set(problems))[:10])


def test_category_nav_only_links_generated_pages():
    """カテゴリナビが、実際に生成されたページだけを指している。"""
    cat_dir = STATIC / "blog" / "cat"
    generated = {p.name for p in cat_dir.glob("*.html")}
    problems = []
    for page in _pages():
        html = page.read_text(encoding="utf-8")
        for m in re.findall(r'href="/blog/cat/([^"]+)"', html):
            if m not in generated:
                problems.append(f"{page.relative_to(STATIC)} → /blog/cat/{m}")
    assert not problems, "生成されていないカテゴリページへのリンク: " + "; ".join(
        sorted(set(problems))[:10]
    )

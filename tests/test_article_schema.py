"""記事の構造化データ（JSON-LD）が Google の要件を満たしているかの検証。

記事は135本あり、執筆時期によって JSON-LD の書式がばらついていた。
点検時点では image が全135記事で欠落しており（Article の必須項目）、
author / datePublished / dateModified / description にも欠落があった。
さらに @type が BlogPosting と Article で混在していた。

不足を直すのは scripts/fix_article_schema.py。このテストは、
記事を追加・編集したときに同じ欠落が再発するのを防ぐ。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

BLOG = Path(__file__).resolve().parent.parent / "static" / "blog"
LD_RE = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)

# Google の Article 構造化データで必須・強く推奨される項目
REQUIRED = ("headline", "image", "author", "publisher", "datePublished", "url")

ARTICLE_TYPES = ("Article", "BlogPosting")


def _articles() -> list[Path]:
    return sorted(BLOG.glob("*.html"))


def _ld_objects(path: Path) -> list[dict]:
    html = path.read_text(encoding="utf-8")
    out = []
    for block in LD_RE.findall(html):
        data = json.loads(block)  # 壊れていれば test_json_ld_is_valid が拾う
        out.extend(data if isinstance(data, list) else [data])
    return out


def test_blog_directory_has_articles():
    assert len(_articles()) > 100


@pytest.mark.parametrize("path", _articles(), ids=lambda p: p.name)
def test_json_ld_is_valid_json(path: Path):
    html = path.read_text(encoding="utf-8")
    for block in LD_RE.findall(html):
        json.loads(block)


def test_every_article_has_article_schema():
    missing = [
        p.name for p in _articles()
        if not any(o.get("@type") in ARTICLE_TYPES for o in _ld_objects(p))
    ]
    assert not missing, f"Article/BlogPosting の構造化データが無い記事: {missing}"


def test_article_schema_has_required_fields():
    """必須項目が揃っている。image は Google の Article で必須。"""
    problems: list[str] = []
    for p in _articles():
        for o in _ld_objects(p):
            if o.get("@type") not in ARTICLE_TYPES:
                continue
            for key in REQUIRED:
                if not o.get(key):
                    problems.append(f"{p.name}: {key}")
    assert not problems, "構造化データの必須項目が欠落: " + ", ".join(problems[:20])


def test_article_type_is_consistent():
    """@type が記事間で混在していない（BlogPosting に統一）。"""
    types = {
        o["@type"]
        for p in _articles()
        for o in _ld_objects(p)
        if o.get("@type") in ARTICLE_TYPES
    }
    assert types == {"BlogPosting"}, f"@type が統一されていない: {sorted(types)}"


def test_dates_are_iso_format():
    bad = []
    for p in _articles():
        for o in _ld_objects(p):
            if o.get("@type") not in ARTICLE_TYPES:
                continue
            for key in ("datePublished", "dateModified"):
                v = o.get(key)
                if v and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
                    bad.append(f"{p.name}: {key}={v}")
    assert not bad, "日付が YYYY-MM-DD 形式でない: " + ", ".join(bad[:10])


def test_urls_are_absolute_https():
    bad = []
    for p in _articles():
        for o in _ld_objects(p):
            if o.get("@type") not in ARTICLE_TYPES:
                continue
            for key in ("url", "image"):
                v = o.get(key)
                if v and not str(v).startswith("https://"):
                    bad.append(f"{p.name}: {key}={v}")
    assert not bad, "絶対URL(https)でない: " + ", ".join(bad[:10])


def test_breadcrumb_urls_resolve():
    """パンくずのリンク先が実在し、noindex ページに落ちない。

    firebase.json の rewrite は "/blog"（末尾スラッシュなし）だけを
    blog.html に振り分ける。"/blog/" は定義が無いため "**" にマッチし、
    noindex の login.html が返る。実際に30記事がこの URL を指していた。
    """
    import json as _json

    STATIC = BLOG.parent
    cfg = _json.loads((STATIC.parent / "firebase.json").read_text(encoding="utf-8"))
    # ワイルドカード rewrite を撤去したので rewrites キー自体が無い。
    # 未定義パスは 404 になるため、この検査はむしろ厳しくなった。
    rewrites = {r["source"] for r in cfg["hosting"].get("rewrites", [])}
    redirected = {r["source"] for r in cfg["hosting"]["redirects"]}
    base = "https://get-tohon.online"

    # 統合済み（noindex）の記事は丸ごと 301 されるので検査しない。
    # 自分自身を指す最後の項目が 301 対象になるのは当然で、
    # そのページ自体が表示されない以上パンくずも描画されない。
    noindex = {
        (STATIC / a["url"].lstrip("/")).name
        for a in _json.loads((BLOG / "articles.json").read_text(encoding="utf-8"))
        if a.get("noindex")
    }

    problems = []
    for p in _articles():
        if p.name in noindex:
            continue
        for o in _ld_objects(p):
            if o.get("@type") != "BreadcrumbList":
                continue
            for item in o.get("itemListElement", []):
                url = item.get("item")
                if not url:
                    continue
                path = url.replace(base, "")
                if path in ("", "/"):
                    continue                      # トップページ
                if path in rewrites:
                    continue                      # rewrite で解決される
                if path in redirected:
                    problems.append(f"{p.name}: {path} は301される")
                elif not (STATIC / path.lstrip("/")).is_file():
                    problems.append(f"{p.name}: {path} に実ファイルが無い")
    assert not problems, "パンくずのリンク先: " + "; ".join(sorted(set(problems))[:10])

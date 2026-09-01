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

    以前は firebase.json の "**" → /login.html により、存在しない URL でも
    noindex の LP が 200 で返っていた（404 にならないぶん気づきにくかった）。
    ワイルドカードを撤去したので、今は素直に 404 になる。
    """
    cfg = _config()
    rewrites = {r["source"] for r in cfg["hosting"].get("rewrites", [])}
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


# ── 検索対象に残した記事どうしの繋がり ──────────────────────────────
#
# 2026-09、Search Console の内部リンクレポートで、**Google が把握している
# リンクの行き先がトップページ1つだけ**（48本）だった。約100ページある
# サイトで、ブログの記事同士の繋がりが存在しないように見えていた。
#
# 同時期の「クロール済み - インデックス未登録」84件を分類すると、本当の
# 問題は3件だけで（残りは301の残骸と、noindex 適用前のクロール）、その3件
# `family-recipe-share` / `food-budget-app` / `kakeibo-app-compare` は
# **そろって「他の残した記事からリンクを受けていない」側**にいた。
# 着手前は、被リンク0本が8本・発リンク0本が9本あった。
#
# noindex にした76本からリンクを張っても持続しない（Google は長期の
# noindex ページのクロール頻度を落とす）。**効くのは Google が見続ける
# ページ＝検索対象に残した記事どうしのリンク。**


def _kept_slugs() -> set[str]:
    """検索対象に残っている記事のスラッグ。

    noindex（統合済み）と searchExclude（公開したまま検索対象外）を除く。
    build_blog.py の絞り込みと同じ条件にしてある。
    """
    arts = json.loads((STATIC / "blog" / "articles.json").read_text(encoding="utf-8"))
    if isinstance(arts, dict):
        arts = arts.get("articles", arts)
    redirected = {
        re.sub(r"^.*/blog/", "", r["source"]).replace(".html", "")
        for r in _config()["hosting"].get("redirects", [])
        if r.get("type") == 301 and "/blog/" in r.get("source", "")
    }
    return {
        a["slug"] for a in arts
        if a.get("slug") and not a.get("noindex") and not a.get("searchExclude")
        and a["slug"] not in redirected
    }


def _kept_link_graph() -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    """残した記事どうしのリンクを (発, 被) で返す。"""
    kept = _kept_slugs()
    out: dict[str, set[str]] = {s: set() for s in kept}
    inb: dict[str, set[str]] = {s: set() for s in kept}
    for slug in kept:
        html = (STATIC / "blog" / f"{slug}.html").read_text(encoding="utf-8")
        for target in re.findall(r"/blog/([a-z0-9-]+)\.html", html):
            if target in kept and target != slug:
                out[slug].add(target)
                inb[target].add(slug)
    return out, inb


def test_kept_articles_are_not_link_islands():
    """残した記事は、どれも他の残した記事から辿れること。

    被リンクが0だと、Google から見て blog.html 経由の1本しか入り口が無い。
    落ちた3件はいずれもこの状態だった。
    """
    _, inbound = _kept_link_graph()
    orphans = sorted(s for s, srcs in inbound.items() if not srcs)
    assert not orphans, (
        "他の『検索対象に残した記事』から1本もリンクされていない: " + ", ".join(orphans)
    )


def test_kept_articles_link_out_to_each_other():
    """残した記事から、他の残した記事へ少なくとも1本出ていること。

    発リンクが無い記事は行き止まりで、クローラをそこで止める。
    """
    outbound, _ = _kept_link_graph()
    dead_ends = sorted(s for s, tgts in outbound.items() if not tgts)
    assert not dead_ends, (
        "他の『検索対象に残した記事』へ1本もリンクしていない: " + ", ".join(dead_ends)
    )


def test_kept_article_links_point_at_real_files():
    """束の中のリンク先が実在すること（統合で消えた記事を指していない）。"""
    outbound, _ = _kept_link_graph()
    missing = {
        f"{src} → {tgt}"
        for src, tgts in outbound.items() for tgt in tgts
        if not (STATIC / "blog" / f"{tgt}.html").exists()
    }
    assert not missing, "リンク先のファイルが無い: " + ", ".join(sorted(missing))

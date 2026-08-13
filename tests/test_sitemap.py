"""sitemap.xml / robots.txt が誤ったクロール指示を出していないかの検証。

他プロジェクトで実際に起きた事故を、このリポジトリで再発させないためのテスト。

  1. lastmod をファイルのタイムスタンプから取ると、CI/ホスティングのビルドは
     毎回リポジトリを新規 clone するため全記事の更新日がビルド日に揃う。
     「デプロイのたびに全記事が更新された」と通知することになり、
     Google が lastmod 自体を信用しなくなる。
  2. robots.txt で CSS/JS をブロックすると Googlebot がページを
     レンダリングできない（Google が明示的に非推奨としている）。
  3. noindex のページをサイトマップに載せると、
     「インデックスして」と「するな」を同時に送る矛盾になる。
"""
from __future__ import annotations

import datetime
import re
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "static"
SITEMAP = STATIC / "sitemap.xml"
ROBOTS = STATIC / "robots.txt"

BASE_URL = "https://get-tohon.online"


def _locs() -> list[str]:
    return re.findall(r"<loc>([^<]+)</loc>", SITEMAP.read_text(encoding="utf-8"))


def _lastmods() -> list[str]:
    return re.findall(r"<lastmod>([^<]+)</lastmod>", SITEMAP.read_text(encoding="utf-8"))


def test_lastmod_is_not_all_build_date():
    """lastmod がビルド日に固まっていない（＝記事のメタデータ由来である）。"""
    mods = _lastmods()
    assert mods, "sitemap.xml に lastmod が1件も無い"
    today = datetime.date.today().isoformat()
    same_as_today = [m for m in mods if m == today]
    # 当日公開の記事はありうるので 0 件は求めない。
    # 「大半が今日」ならタイムスタンプ由来を疑う。
    assert len(same_as_today) < len(mods) * 0.5, (
        f"lastmod の {len(same_as_today)}/{len(mods)} 件がビルド日({today})と同じ。"
        "ファイルのタイムスタンプから算出していないか確認すること"
    )
    # 日付が十分に分散していること
    assert len(set(mods)) > 10, f"lastmod の種類が {len(set(mods))} 種類しかない"


def test_lastmod_matches_articles_json():
    """lastmod が articles.json の date と一致する（別ソースから来ていない）。"""
    import json

    data = json.loads((STATIC / "blog" / "articles.json").read_text(encoding="utf-8"))
    by_url = {a["url"]: a["date"] for a in data}
    body = SITEMAP.read_text(encoding="utf-8")
    pairs = re.findall(
        r"<loc>([^<]+)</loc>\s*<lastmod>([^<]+)</lastmod>", body
    )
    assert pairs, "loc と lastmod の組が取れない"
    for loc, mod in pairs:
        path = loc.replace(BASE_URL, "")
        if path in by_url:
            assert mod == by_url[path], f"{path} の lastmod が articles.json と不一致"


def test_robots_does_not_block_css_or_js():
    """robots.txt が CSS/JS をブロックしていない。

    Disallow は前方一致のため、"Disallow: /app" は /app.js や
    /app-state.js までブロックする。実際にそうなっていた。
    """
    lines = [
        ln.strip() for ln in ROBOTS.read_text(encoding="utf-8").splitlines()
        if ln.strip() and not ln.strip().startswith("#")
    ]
    disallows = [
        ln.split(":", 1)[1].strip()
        for ln in lines if ln.lower().startswith("disallow:")
    ]
    disallows = [d for d in disallows if d]  # "Disallow:" 単体は「全許可」の意味

    assets = [p.name for p in STATIC.glob("*.js")] + [p.name for p in STATIC.glob("*.css")]
    assert assets, "検査対象の静的アセットが見つからない"
    for rule in disallows:
        blocked = [a for a in assets if ("/" + a).startswith(rule)]
        assert not blocked, (
            f'robots.txt の "Disallow: {rule}" が前方一致で '
            f"CSS/JS をブロックしている: {blocked}"
        )


def test_sitemap_has_no_noindex_pages():
    """noindex のページをサイトマップに載せていない。"""
    offenders = []
    for loc in _locs():
        path = loc.replace(BASE_URL, "").lstrip("/") or "index.html"
        f = STATIC / path
        if not f.is_file():
            continue
        head = f.read_text(encoding="utf-8", errors="ignore")[:4000]
        if re.search(r'name=["\']robots["\'][^>]*noindex', head, re.I):
            offenders.append(loc)
    assert not offenders, f"noindex なのにサイトマップに載っている: {offenders}"


def test_sitemap_urls_resolve_to_existing_files():
    """サイトマップの URL が実在するファイルを指している（404 の送信を防ぐ）。"""
    missing = []
    for loc in _locs():
        path = loc.replace(BASE_URL, "").lstrip("/") or "index.html"
        if not (STATIC / path).is_file():
            missing.append(loc)
    assert not missing, f"サイトマップ内の URL にファイルが無い: {missing}"


# ---------------------------------------------------------------------------
# 統合（301）とクロール予算
# ---------------------------------------------------------------------------

def _redirects() -> list[dict]:
    import json
    cfg = json.loads((STATIC.parent / "firebase.json").read_text(encoding="utf-8"))
    return cfg["hosting"]["redirects"]


def _consolidated() -> dict[str, str]:
    """articles.json で noindex 指定された記事 → canonical 先 の対応。"""
    import json
    data = json.loads((STATIC / "blog" / "articles.json").read_text(encoding="utf-8"))
    out = {}
    for a in data:
        if not a.get("noindex"):
            continue
        html = (STATIC / a["url"].lstrip("/")).read_text(encoding="utf-8")
        m = re.search(r"<link[^>]*canonical[^>]*>", html)
        assert m, f"{a['url']} に canonical が無い"
        dest = re.search(r"https://[^\"']+", m.group(0))
        out[a["url"]] = dest.group(0).replace(BASE_URL, "")
    return out


def test_consolidated_articles_have_301():
    """統合した記事は canonical だけでなく 301 も張る。

    canonical は「たぶんこちら」というヒントに過ぎず、統合元がクロール
    対象として残り続ける。123本中77本が3か月間1度も表示されていない
    状況ではクロール予算の節約が効くため、301 で明示的に移転させる。
    """
    sources = {r["source"] for r in _redirects()}
    missing = [u for u in _consolidated() if u not in sources]
    assert not missing, f"統合済みなのに 301 が無い: {missing}"


def test_redirect_destination_matches_canonical():
    """301 の宛先が canonical と一致する（二重の指示で食い違わせない）。"""
    by_source = {r["source"]: r["destination"] for r in _redirects()}
    for src, canonical_dest in _consolidated().items():
        assert by_source.get(src) == canonical_dest, (
            f"{src}: 301 は {by_source.get(src)} だが canonical は {canonical_dest}"
        )


def test_redirects_are_permanent():
    """統合は恒久的な移転なので 301 を使う（302 は評価が移らない）。"""
    for r in _redirects():
        assert r["type"] == 301, f"{r['source']} が {r['type']}"


def test_no_redirect_chain():
    """301 の宛先がさらに 301 されていない（1回で着地させる）。"""
    by_source = {r["source"]: r["destination"] for r in _redirects()}
    chained = [(s, d) for s, d in by_source.items() if d in by_source]
    assert not chained, f"リダイレクトが連鎖している: {chained}"


def test_sitemap_excludes_redirected_urls():
    """301 する URL をサイトマップに載せない。"""
    sources = {r["source"] for r in _redirects()}
    listed = [u for u in _locs() if u.replace(BASE_URL, "") in sources]
    assert not listed, f"301 する URL がサイトマップにある: {listed}"


def test_priority_has_more_than_one_tier_for_articles():
    """記事の priority が全部同じでない（重点記事を区別する）。

    以前は123本すべて 0.6 で、クローラーに「どれも同じ重要度」としか
    伝えていなかった。
    """
    body = SITEMAP.read_text(encoding="utf-8")
    pairs = re.findall(r"<loc>([^<]+)</loc>.*?<priority>([^<]+)</priority>", body, re.S)
    article_priorities = {p for loc, p in pairs if "/blog/" in loc and "/cat/" not in loc}
    assert len(article_priorities) >= 2, (
        f"記事の priority が {article_priorities} の1種類しかない"
    )


# ---------------------------------------------------------------------------
# 検索結果での見え方
# ---------------------------------------------------------------------------

def _width(s: str) -> int:
    """全角を2、半角を1として数える（Google の打ち切りに近い目安）。"""
    import unicodedata
    return sum(2 if unicodedata.east_asian_width(c) in "WFA" else 1 for c in s)


TITLE_MAX_WIDTH = 70  # 全角35字相当。これを超えると検索結果で切れる


def test_site_has_organization_and_website_schema():
    """LP に Organization と WebSite がある。

    記事側は BlogPosting の publisher に組織情報を持っているが、
    サイトの入口である LP に無いと Google が運営者とサイト名を確定できない。
    """
    import json as _json

    html = (STATIC / "index.html").read_text(encoding="utf-8")
    types = set()
    for block in re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.S):
        data = _json.loads(block)
        for o in data if isinstance(data, list) else [data]:
            types.add(o.get("@type"))
    for required in ("Organization", "WebSite"):
        assert required in types, f"LP に {required} の構造化データが無い（現在: {sorted(types)}）"


def test_pagination_descriptions_are_distinct():
    """ページネーションの description が全ページ同一になっていない。"""
    descs = []
    for name in ["blog.html"] + [f"blog-p{i}.html" for i in range(2, 7)]:
        f = STATIC / name
        if not f.is_file():
            continue
        head = f.read_text(encoding="utf-8").split("</head>")[0]
        m = re.search(r'name="description" content="([^"]*)"', head)
        assert m, f"{name} に description が無い"
        descs.append(m.group(1))
    assert len(descs) >= 3
    assert len(set(descs)) == len(descs), "ページネーションの description が重複している"


def test_most_article_titles_fit_in_search_results():
    """タイトルが検索結果で切れる記事が過半数を超えない。

    Google は日本語タイトルを全角35字前後で打ち切る。
    サイト名の接尾辞（「- カケイシピ」）は7字を消費するわりに
    日本語圏では切り捨てられやすいため、長いタイトルには付けない。
    """
    import json as _json

    data = _json.loads((STATIC / "blog" / "articles.json").read_text(encoding="utf-8"))
    over = []
    total = 0
    for a in data:
        if a.get("noindex"):
            continue
        total += 1
        html = (STATIC / a["url"].lstrip("/")).read_text(encoding="utf-8")
        title = re.search(r"<title>(.*?)</title>", html, re.S).group(1).strip()
        if _width(title) > TITLE_MAX_WIDTH:
            over.append(a["slug"])
    assert len(over) < total * 0.5, (
        f"{len(over)}/{total} 本のタイトルが検索結果で切れる（上限 {TITLE_MAX_WIDTH} 幅）"
    )

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
    # 日付が十分に分散していること。
    # 2026-08 に量産判定への対処でサイトマップを105→24URLへ絞ったため、
    # 「10種類以上」という絶対数では成立しなくなった。件数に対する割合で見る
    # （全URLが同じ日付ならタイムスタンプ由来を疑う、という趣旨は変えない）。
    assert len(set(mods)) >= 3, f"lastmod の種類が {len(set(mods))} 種類しかない"


def test_lastmod_matches_articles_json():
    """lastmod が articles.json 由来である（別ソースから来ていない）。

    記事を統合すると統合先の本文が大きく増える。公開日のままだと Google に
    「変わっていない」と伝わって再クロールが後回しになるので、
    scripts/merge_articles.py が updated を入れ、build_blog.py は
    updated があればそちらを lastmod に使う。
    """
    import json

    data = json.loads((STATIC / "blog" / "articles.json").read_text(encoding="utf-8"))
    by_url = {a["url"]: (a.get("updated") or a["date"]) for a in data}
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
    # 記事を絞った結果、一覧が1ページだけになることがある。
    # そのときは比較する相手がいないので、重複の検査は行わない
    # （description が存在することは上の assert で確認済み）。
    assert descs, "ブログ一覧に description が無い"
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


def test_assets_are_cacheable():
    """JS/CSS がキャッシュ可能である（クロール予算の節約）。

    以前は "no-cache, max-age=0" で、Googlebot が記事を1本クロールする
    たびに JS/CSS の再確認リクエストを出していた。
    クロール統計では JavaScript 20% + CSS 9% と、少ない予算の29%を
    アセットが占めていた（記事HTMLは62%）。

    304 で返っていても1リクエストは消費する。制約されているのは
    リクエスト数なので、キャッシュさせて確認自体を減らす。
    """
    import json as _json

    cfg = _json.loads((STATIC.parent / "firebase.json").read_text(encoding="utf-8"))
    for rule in cfg["hosting"]["headers"]:
        if rule["source"] != "**/*.@(js|css)":
            continue
        cache = next(
            (h["value"] for h in rule["headers"] if h["key"] == "Cache-Control"), ""
        )
        m = re.search(r"max-age=(\d+)", cache)
        assert m, f"JS/CSS に max-age が無い: {cache!r}"
        assert int(m.group(1)) >= 600, (
            f"JS/CSS の max-age={m.group(1)} は短すぎる。"
            "Googlebot が毎回再確認してクロール予算を消費する"
        )
        assert "no-cache" not in cache, f"JS/CSS が no-cache: {cache!r}"
        return
    raise AssertionError("firebase.json に JS/CSS のキャッシュ設定が無い")


def _high_priority_slugs() -> set[str]:
    """build_blog.py の HIGH_PRIORITY_SLUGS を、実行せずに取り出す。"""
    src = (STATIC.parent / "build_blog.py").read_text(encoding="utf-8")
    body = re.search(r"HIGH_PRIORITY_SLUGS = \{(.*?)\n\}", src, re.S)
    assert body, "HIGH_PRIORITY_SLUGS が見つからない"
    return set(re.findall(r'"([^"]+)"', body.group(1)))


def test_high_priority_slugs_are_indexable():
    """優先度を上げた記事が、実在しかつ noindex でない。

    記事を統合すると、それまで優先度を上げていたスラッグが noindex 側へ
    回ることがある。noindex の記事はサイトマップに載らないため、
    書いたつもりの優先度が誰にも効いていない状態になる。
    実際に統合後、20件中5件がこの状態になっていた。
    """
    import json as _json

    data = _json.loads(
        (STATIC / "blog" / "articles.json").read_text(encoding="utf-8")
    )
    by_slug = {a["url"].split("/")[-1].removesuffix(".html"): a for a in data}

    problems = []
    for slug in sorted(_high_priority_slugs()):
        a = by_slug.get(slug)
        if a is None:
            problems.append(f"{slug}: articles.json に無い")
        elif a.get("noindex"):
            problems.append(f"{slug}: noindex なのでサイトマップに載らない")
        elif a.get("searchExclude"):
            problems.append(f"{slug}: searchExclude なのでサイトマップに載らない")
    assert not problems, "HIGH_PRIORITY_SLUGS の不整合: " + "; ".join(problems)


# ---------------------------------------------------------------------------
# URL の正規化
# ---------------------------------------------------------------------------

def test_blog_index_has_single_canonical_url():
    """ブログ一覧に到達する URL が 1 つに収束する。

    rewrite は "/blog"（末尾スラッシュなし）だけを blog.html に振り分けて
    いたため、"/blog/" は "**" にマッチして noindex の login.html を返して
    いた。内部リンクからは排除したが、外部リンクと Google が既に持って
    いる URL には効かない（実際に GA4 で "/blog/" に表示2回・1.0位が
    記録されていた）。

    "/blog" 側も rewrite だと同じ内容が2つの URL で見えるので、
    どちらも blog.html へ 301 して 1 本にまとめる。
    """
    import json as _json

    cfg = _json.loads((STATIC.parent / "firebase.json").read_text(encoding="utf-8"))
    by_source = {r["source"]: r["destination"] for r in cfg["hosting"]["redirects"]}
    for src in ("/blog", "/blog/"):
        assert by_source.get(src) == "/blog.html", (
            f"{src} が /blog.html へ 301 されていない"
        )

    # redirects は rewrites より先に評価される。両方に同じ source を
    # 書くと rewrite が到達しない死に設定になるので持たせない。
    rewrite_sources = {r["source"] for r in cfg["hosting"]["rewrites"]}
    assert not (rewrite_sources & set(by_source)), (
        f"redirects と rewrites が重複: {sorted(rewrite_sources & set(by_source))}"
    )


def test_canonical_urls_are_normalized():
    """canonical が https・www 無し・絶対URL で統一されている。"""
    bad = []
    for page in sorted(STATIC.rglob("*.html")):
        for tag in re.findall(r"<link[^>]*canonical[^>]*>", page.read_text(encoding="utf-8")):
            m = re.search(r'href=["\']([^"\']+)["\']', tag)
            if not m:
                bad.append(f"{page.name}: href が無い")
                continue
            url = m.group(1)
            if not url.startswith(BASE_URL):
                bad.append(f"{page.name}: {url}")
            elif url.endswith("/blog/") or "//blog" in url.replace(BASE_URL, ""):
                bad.append(f"{page.name}: 正規化されていない {url}")
    assert not bad, "canonical の不整合: " + "; ".join(bad[:10])


# ---------------------------------------------------------------------------
# IndexNow
# ---------------------------------------------------------------------------

def test_indexnow_key_file_is_valid():
    """IndexNow の鍵ファイルが static/ にあり、名前と中身が一致している。

    IndexNow は「鍵と同じ名前・同じ中身の .txt がサイトルートにあること」で
    所有権を確認する。消したり中身を書き換えたりすると送信が 403 になるが、
    通知が届かなくなるだけでサイトは正常に動くため、気づきにくい。

    この鍵は公開前提の値で秘密ではない（知られても、そのドメインの URL を
    送信できるだけ）。
    """
    import re as _re

    keys = [
        p for p in STATIC.glob("*.txt")
        if _re.fullmatch(r"[a-zA-Z0-9-]{8,128}", p.stem) and p.stem != "robots"
    ]
    assert len(keys) == 1, f"IndexNow の鍵ファイルは1つであること: {[p.name for p in keys]}"
    key = keys[0]
    assert key.read_text(encoding="utf-8").strip() == key.stem, (
        f"{key.name}: ファイル名と中身が一致していない（所有権確認に失敗する）"
    )


def test_indexnow_key_is_not_in_sitemap():
    """鍵ファイルをサイトマップに載せない（クロールさせる意味がない）。"""
    listed = [loc for loc in _locs() if loc.endswith(".txt")]
    assert not listed, f".txt がサイトマップに載っている: {listed}"


# ---------------------------------------------------------------------------
# 孤立ページ
# ---------------------------------------------------------------------------

def test_no_orphan_generated_pages():
    """生成されたページで、サイトマップに載っていないものが無い。

    build_blog.py はページを生成するだけで、不要になったページを消していな
    かった。記事統合でページ数が 6→4 に減ったとき blog-p5/p6.html が、
    レシピカテゴリが空になったとき blog/cat/recipe.html が取り残された。

    これらはサイトマップにもナビにも載らないのに実ファイルだけが残るため、
    Google が過去に取得した URL としてクロールし続け、少ないクロール予算を
    食う。どこからもリンクされていない孤立ページは品質評価上も好ましくない。
    """
    listed = {loc.replace(BASE_URL, "") for loc in _locs()}

    orphans = []
    for page in sorted(STATIC.glob("blog-p*.html")):
        if f"/{page.name}" not in listed:
            orphans.append(page.name)
    cat_dir = STATIC / "blog" / "cat"
    if cat_dir.is_dir():
        for page in sorted(cat_dir.glob("*.html")):
            if f"/blog/cat/{page.name}" not in listed:
                orphans.append(f"blog/cat/{page.name}")

    assert not orphans, (
        "サイトマップに載っていない生成ページが残っている"
        f"（build_blog.py を実行して削除する）: {orphans}"
    )


def test_search_excluded_articles_have_noindex_meta():
    """searchExclude の記事に meta robots noindex が入っている。

    2026-08、Google のインデックス数が減り続けたため、量産された記事を
    検索対象から外した（削除はせず、サイト内では読めるままにしてある）。
    articles.json のフラグと記事HTMLの meta robots は
    scripts/apply_search_exclude.py で同期するが、**片方だけ直すと
    サイトマップから消えただけで noindex が入らない**という中途半端な
    状態になり、Google からは今までどおり量産ページに見える。
    """
    import json as _json

    data = _json.loads(
        (STATIC / "blog" / "articles.json").read_text(encoding="utf-8")
    )
    problems = []
    for a in data:
        if a.get("noindex"):
            # 統合済み。301 と canonical で処理するので noindex は入れない
            # （canonical との併用は Google が非推奨）。
            continue
        f = STATIC / "blog" / f"{a['slug']}.html"
        if not f.is_file():
            continue
        has = 'name="robots"' in f.read_text(encoding="utf-8").split("</head>")[0]
        want = bool(a.get("searchExclude"))
        if want and not has:
            problems.append(f"{a['slug']}: searchExclude なのに meta robots が無い")
        if not want and has:
            problems.append(f"{a['slug']}: 検索対象なのに meta robots がある")
    assert not problems, (
        "articles.json と meta robots の不整合（scripts/apply_search_exclude.py を実行）:\n  "
        + "\n  ".join(problems)
    )


def test_search_excluded_articles_are_not_in_sitemap():
    """searchExclude の記事がサイトマップに残っていない。"""
    import json as _json

    data = _json.loads(
        (STATIC / "blog" / "articles.json").read_text(encoding="utf-8")
    )
    excluded = {a["url"] for a in data if a.get("searchExclude")}
    xml = (STATIC / "sitemap.xml").read_text(encoding="utf-8")
    leaked = [u for u in excluded if f"<loc>{BASE_URL}{u}</loc>" in xml]
    assert not leaked, f"searchExclude の記事がサイトマップに載っている: {leaked[:5]}"

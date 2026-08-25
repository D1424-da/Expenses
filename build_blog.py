#!/usr/bin/env python3
"""
Build paginated blog index pages, category pages, and sitemap.
Reads /home/user/Expenses/static/blog/articles.json as single source of truth.
"""
import json
import math
import os
from pathlib import Path
from datetime import datetime

# ── Config ────────────────────────────────────────────────────────────────
STATIC = Path("/home/user/Expenses/static")
ARTICLES_JSON = STATIC / "blog" / "articles.json"
ARTICLES_PER_PAGE = 24
BASE_URL = "https://get-tohon.online"

# Category slug mapping
CATEGORY_SLUGS = {
    "節約術":    "setsuyaku",
    "家計管理":  "kakeibo",
    "献立・レシピ": "kondate",
    "レシピ":    "recipe",
    "アプリ活用": "app",
    "ライフスタイル": "lifestyle",
    "節約レシピ": "setsuyaku-recipe",
    "その他":    "other",
}

# All canonical categories for navigation
NAV_CATEGORIES = [
    ("節約術",    "setsuyaku"),
    ("家計管理",  "kakeibo"),
    ("献立・レシピ", "kondate"),
    ("アプリ活用", "app"),
    ("ライフスタイル", "lifestyle"),
]

# ── Load articles ──────────────────────────────────────────────────────────
with open(ARTICLES_JSON, encoding="utf-8") as f:
    all_articles = json.load(f)

# 検索対象に残す記事だけを一覧・カテゴリ・サイトマップに載せる。
#   noindex       … 統合で消えた記事（301 と canonical で処理済み）
#   searchExclude … 公開したまま検索対象から外す記事
#                   （scripts/apply_search_exclude.py が meta robots を入れる）
# どちらもサイトマップと一覧から外す。記事HTML自体は消さないので、
# 直接URLを開けば読めるし、フラグを戻せば元どおりになる。
articles = [
    a for a in all_articles
    if not a["noindex"] and not a.get("searchExclude")
]
articles.sort(key=lambda a: a["date"], reverse=True)

print(f"Total indexable articles: {len(articles)}")

# カテゴリごとの記事を先に集計する。
# cat_nav_html() が「記事0本のカテゴリはリンクしない」判定に使うため、
# 一覧ページ（A節）の生成より前に用意しておく必要がある。
from collections import defaultdict
cat_articles = defaultdict(list)
for a in articles:
    cat = a["category"]
    for std_cat in CATEGORY_SLUGS:
        if cat == std_cat:
            cat_articles[std_cat].append(a)
            break
    else:
        cat_articles["その他"].append(a)


# ── Helpers ────────────────────────────────────────────────────────────────
def format_date_jp(date_str):
    """2026-07-09 → 2026年07月09日"""
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d")
        return f"{d.year}年{d.month:02d}月{d.day:02d}日"
    except:
        return date_str


def html_head(title, description, canonical, prev_url=None, next_url=None):
    """Generate <head> for blog index pages"""
    prev_link = f'  <link rel="prev" href="{BASE_URL}{prev_url}" />\n' if prev_url else ""
    next_link = f'  <link rel="next" href="{BASE_URL}{next_url}" />\n' if next_url else ""
    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script src="/redirect.js"></script>
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-YTNPDRH19H"></script>
  <script src="/analytics.js"></script>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="manifest" href="/manifest.json" />
  <title>{title}</title>
  <meta name="description" content="{description}" />
  <link rel="canonical" href="{BASE_URL}{canonical}" />
{prev_link}{next_link}  <meta property="og:type" content="website" />
  <meta property="og:url" content="{BASE_URL}{canonical}" />
  <meta property="og:title" content="{title}" />
  <meta property="og:description" content="{description}" />
  <meta property="og:image" content="{BASE_URL}/ogp.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{title}" />
  <meta name="twitter:description" content="{description}" />
  <meta name="twitter:image" content="{BASE_URL}/ogp.png" />
  <script type="application/ld+json">
  {{
    "@context": "https://schema.org",
    "@type": "Blog",
    "name": "カケイシピ ブログ｜食費節約・家計管理・レシピ",
    "description": "{description}",
    "url": "{BASE_URL}{canonical}",
    "inLanguage": "ja",
    "publisher": {{
      "@type": "Organization",
      "name": "カケイシピ",
      "url": "{BASE_URL}/",
      "logo": {{"@type": "ImageObject", "url": "{BASE_URL}/favicon.svg"}}
    }}
  }}
  </script>
  <link rel="stylesheet" href="/tokens.css" />
  <link rel="stylesheet" href="/blog-index.css" />
</head>"""


def header_html():
    return """
<header class="bh">
  <a class="bh-logo" href="/">カケイシピ</a>
  <nav class="bh-nav">
    <a href="/blog.html">ブログ一覧</a>
    <a class="bh-cta" href="/login.html">無料で試す</a>
  </nav>
</header>"""


def footer_html():
    return """
<footer class="bf">
  <div class="bf-logo">カケイシピ</div>
  <nav class="bf-links">
    <a href="/">カケイシピ TOP</a>
    <a href="/blog.html">ブログ一覧</a>
    <a href="/terms.html" rel="nofollow">利用規約</a>
    <a href="/privacy.html" rel="nofollow">プライバシーポリシー</a>
  </nav>
  <p>© 2026 カケイシピ</p>
</footer>"""


def cat_nav_html(active_slug=None):
    """カテゴリナビ。記事が1本も無いカテゴリはリンクしない。

    カテゴリページは記事があるカテゴリだけ生成される（下の B 節）。
    NAV_CATEGORIES をそのまま並べると、記事0本のカテゴリ
    （"ライフスタイル"）へのリンクだけが実在しないページを指し、
    firebase.json の "**" → login.html に落ちて noindex ページが返る。
    実際に13ページからこのリンクが張られていた。
    """
    items = ['<a href="/blog.html" class="cat-btn{}">すべて</a>'.format(
        ' active' if active_slug is None else '')]
    for name, slug in NAV_CATEGORIES:
        if not cat_articles.get(name):
            continue
        cls = ' active' if slug == active_slug else ''
        items.append(f'<a href="/blog/cat/{slug}.html" class="cat-btn{cls}">{name}</a>')
    return '<nav class="cat-nav">\n      ' + '\n      '.join(items) + '\n    </nav>'


def card_html(article):
    date_jp = format_date_jp(article["date"])
    title = article["title"].replace('"', '&quot;').replace('<', '&lt;').replace('>', '&gt;')
    excerpt = article["excerpt"].replace('<', '&lt;').replace('>', '&gt;')
    category = article["category"].replace('<', '&lt;')
    emoji = article["emoji"]
    url = article["url"]
    return f"""      <a href="{url}" class="blog-card">
        <div class="blog-card-img">{emoji}</div>
        <div class="blog-card-body">
          <div class="blog-card-cat">{category}</div>
          <h2 class="blog-card-title">{title}</h2>
          <p class="blog-card-excerpt">{excerpt}</p>
          <div class="blog-card-date">{date_jp}</div>
        </div>
      </a>"""


def pagination_html(page, total_pages, url_fn):
    parts = []
    if page > 1:
        parts.append(f'<a href="{url_fn(page - 1)}" class="page-btn page-prev">← 前のページ</a>')
    parts.append(f'<span class="page-current">{page} / {total_pages}</span>')
    if page < total_pages:
        parts.append(f'<a href="{url_fn(page + 1)}" class="page-btn page-next">次のページ →</a>')
    return '<nav class="pagination">\n      ' + '\n      '.join(parts) + '\n    </nav>'


def page_url(n):
    return "/blog.html" if n == 1 else f"/blog-p{n}.html"


# ── A. Paginated Index Pages ───────────────────────────────────────────────
total = len(articles)
total_pages = math.ceil(total / ARTICLES_PER_PAGE)

for page in range(1, total_pages + 1):
    start = (page - 1) * ARTICLES_PER_PAGE
    end = start + ARTICLES_PER_PAGE
    page_articles = articles[start:end]

    canonical = page_url(page)
    prev_url = page_url(page - 1) if page > 1 else None
    next_url = page_url(page + 1) if page < total_pages else None

    title = "食費節約・家計管理・レシピの情報ブログ｜カケイシピ公式"
    if page > 1:
        title = f"ブログ記事一覧（{page}ページ目）｜カケイシピ"
    # description はページごとに変える。
    # 以前は末尾の「ページN/6」以外が全ページ同一で、実質的な重複だった。
    # そのページに実際に載っている記事のカテゴリと代表タイトルを入れて、
    # 検索結果でどのページを開けばよいかが分かるようにする。
    if page == 1:
        description = (
            f"カケイシピ公式ブログ。レシート撮影で食費を自動記録し、AIが献立を提案。"
            f"食費節約・家計管理・献立レシピの実践記事{total}本を公開中。"
        )
    else:
        page_cats = []
        for a in page_articles:
            if a["category"] not in page_cats:
                page_cats.append(a["category"])
        lead = page_articles[0]["title"].split("｜")[0].split("<br")[0]
        description = (
            f"{'・'.join(page_cats[:3])}の記事一覧（{page}/{total_pages}ページ）。"
            f"「{lead}」など{len(page_articles)}本を掲載。"
        )

    cards = "\n".join(card_html(a) for a in page_articles)
    pager = pagination_html(page, total_pages, page_url)

    # 注目記事ブロック（1ページ目のみ）。
    # リンク先は統合で変わることがある。統合済み記事を指したままにすると
    # 301 を1回はさむので、tests/test_internal_links.py が検出する。
    featured_block = ""
    if page == 1:
        featured_block = """
    <!-- Featured Article -->
    <a href="/blog/fridge-ai-recipe.html" class="featured-card">
      <div class="featured-visual">
        <div class="feat-flow">
          <div class="feat-step">🛒 今日の買い物を記録</div>
          <div class="feat-arrow">↓</div>
          <div class="feat-step">📋 食材リストが自動生成</div>
          <div class="feat-arrow">↓</div>
          <div class="feat-result">🍳 レシピを自動提案</div>
        </div>
      </div>
      <div class="featured-body">
        <div class="featured-label">⭐ 注目機能</div>
        <span class="featured-tag">カケイシピの最強機能</span>
        <h2 class="featured-title">冷蔵庫の中身と買い物履歴から<br>AIがレシピを自動提案</h2>
        <p class="featured-excerpt">レシートを撮るだけで食材が記録され、冷蔵庫に残っている材料からレシピが自動提案されます。献立に悩む時間をなくし、食材を使い切ることで月1〜2万円の食費節約を実現するカケイシピの核心機能を徹底解説。</p>
        <div class="featured-meta">
          <span>2026年07月09日</span>
          <span class="featured-cat-badge">アプリ活用</span>
        </div>
      </div>
    </a>
"""

    hero_h1 = "食費節約・家計管理・レシピのブログ"
    hero_p = f"一人暮らしから家族まで、食費節約と献立管理の実践情報{total}本"

    html_out = f"""{html_head(title, description, canonical, prev_url, next_url)}
<body>
{header_html()}

  <main class="blog-main">
    <div class="blog-hero">
      <h1>{hero_h1}</h1>
      <p>{hero_p}</p>
    </div>

    {cat_nav_html()}
{featured_block}
    <div class="blog-grid">
{cards}
    </div>

    {pager}
  </main>

{footer_html()}
</body>
</html>"""

    out_path = STATIC / ("blog.html" if page == 1 else f"blog-p{page}.html")
    out_path.write_text(html_out, encoding="utf-8")
    print(f"  Written: {out_path.name} ({len(page_articles)} articles)")

print(f"Generated {total_pages} index pages")

# 記事を統合するとページ数が減る。生成しなくなったページネーションページを
# 消さないと、サイトマップにもナビにも載らないのに実ファイルだけが残る。
# Google が過去に取得した URL としてクロールし続け、予算を食う。
# 実際に記事統合（123本→88本）でページ数が 6→4 に減り、
# blog-p5.html / blog-p6.html が取り残された。
for stale in sorted(STATIC.glob("blog-p*.html")):
    n = int(stale.stem.removeprefix("blog-p"))
    if n > total_pages:
        stale.unlink()
        print(f"  Removed (stale): {stale.name}")


# ── B. Category Pages ──────────────────────────────────────────────────────
cat_dir = STATIC / "blog" / "cat"
generated_cats: set[str] = set()
cat_dir.mkdir(exist_ok=True)

for cat_name, slug in CATEGORY_SLUGS.items():
    cat_arts = cat_articles.get(cat_name, [])
    if not cat_arts:
        print(f"  Skip (empty): {cat_name}")
        continue

    canonical = f"/blog/cat/{slug}.html"
    title = f"{cat_name}の記事一覧｜カケイシピブログ"
    description = f"カケイシピブログの{cat_name}カテゴリ記事一覧。全{len(cat_arts)}本。食費節約・家計管理・レシピの実践情報。"

    cards = "\n".join(card_html(a) for a in cat_arts)

    html_out = f"""{html_head(title, description, canonical)}
<body>
{header_html()}

  <main class="blog-main">
    <div class="blog-hero">
      <h1>{cat_name}の記事</h1>
      <p>{cat_name}に関する実践記事 全{len(cat_arts)}本</p>
    </div>

    {cat_nav_html(active_slug=slug)}

    <div class="blog-grid">
{cards}
    </div>

    <div class="cat-back">
      <a href="/blog.html" class="cat-back-link">← すべての記事を見る</a>
    </div>
  </main>

{footer_html()}
</body>
</html>"""

    out_path = cat_dir / f"{slug}.html"
    out_path.write_text(html_out, encoding="utf-8")
    generated_cats.add(slug)
    print(f"  Written: blog/cat/{slug}.html ({len(cat_arts)} articles)")

# 記事が0本になったカテゴリはページを生成しない（cat_nav_html もリンクを出さない）。
# ただし過去に生成した実ファイルが残ると、ページネーションと同じく
# 「どこからもリンクされていないのに存在する」ページになる。
# 実際に統合でレシピカテゴリが空になり、blog/cat/recipe.html が取り残された。
for stale in sorted(cat_dir.glob("*.html")):
    if stale.stem not in generated_cats:
        stale.unlink()
        print(f"  Removed (stale): blog/cat/{stale.name}")

print("Generated category pages")


# ── C. Sitemap ────────────────────────────────────────────────────────────
sitemap_urls = []

# Main pages
# /login.html は含めない。
# firebase.json の rewrites で未定義パスがすべて login.html に流れるため、
# login.html 自身に <meta name="robots" content="noindex, nofollow"> を
# 付けてゴミURLのインデックスを防いでいる。
# その noindex ページをサイトマップに載せると
# 「インデックスして」と「するな」を同時に送る矛盾したシグナルになり、
# Search Console に「送信されたURLに noindex タグが追加されています」が出る。
main_pages = [
    ("/", "weekly"),
    ("/blog.html", "daily"),
]
for path, freq in main_pages:
    sitemap_urls.append(f"""  <url>
    <loc>{BASE_URL}{path}</loc>
    <changefreq>{freq}</changefreq>
    <priority>{"1.0" if path == "/" else "0.9"}</priority>
  </url>""")

# Paginated index pages (page 2+)
for page in range(2, total_pages + 1):
    sitemap_urls.append(f"""  <url>
    <loc>{BASE_URL}{page_url(page)}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>""")

# Category pages
for cat_name, slug in CATEGORY_SLUGS.items():
    if cat_articles.get(cat_name):
        sitemap_urls.append(f"""  <url>
    <loc>{BASE_URL}/blog/cat/{slug}.html</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>""")

# Article pages
#
# 重点記事は priority を上げる。以前は123本すべて 0.6 で、
# クローラーに「どれも同じ重要度」としか伝えていなかった。
# 選定基準は2つ:
#   1. Search Console で実際にクリックを取れている記事（10位以内）
#   2. サイト内から多くリンクされているハブ記事
# 順位や内部リンク構造が変わったら見直すこと。
HIGH_PRIORITY_SLUGS = {
    # 検索対象に残した記事のうち、実績とハブ性で優先度を上げるもの。
    #
    # 2026-08、量産判定への対処で77記事を searchExclude にした際、ここに
    # 書いていたスラッグの大半がサイトマップから外れた。優先度は
    # サイトマップに載る記事にしか効かないので、外した記事は消す。
    # tests/test_sitemap.py が noindex / searchExclude の混入を検出する。
    "family-recipe-share",
    "food-budget-app",
    "kakeibo-app-compare",
    "receipt-kakeibo-basics",
    "recipe-app-compare",
}

# lastmod は公開日ではなく更新日を優先する。記事を統合すると統合先の本文が
# 大きく増えるため、公開日のままだと Google に「変わっていない」と伝わり、
# 再クロールが後回しになる。updated は scripts/merge_articles.py が入れる。
for a in articles:
    priority = "0.8" if a["slug"] in HIGH_PRIORITY_SLUGS else "0.6"
    sitemap_urls.append(f"""  <url>
    <loc>{BASE_URL}{a["url"]}</loc>
    <lastmod>{a.get("updated") or a["date"]}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>{priority}</priority>
  </url>""")

sitemap_xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
sitemap_xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
sitemap_xml += "\n".join(sitemap_urls)
sitemap_xml += "\n</urlset>\n"

(STATIC / "sitemap.xml").write_text(sitemap_xml, encoding="utf-8")
print(f"Generated sitemap.xml with {len(sitemap_urls)} URLs")

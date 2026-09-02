#!/usr/bin/env python3
"""
全ブログ記事に関連記事（同カテゴリ3件）と前後ナビを一括追加する。
既存の <!-- related-articles --> マーカーがあればスキップ（べき等）。
"""
import json
import re
from pathlib import Path

# 絶対パスを埋め込むと書いた本人の1台以外では落ちる（build_blog.py と同じ）。
STATIC = Path(__file__).resolve().parent / "static"
BLOG_DIR = STATIC / "blog"
BASE_URL = "https://get-tohon.online"

# ---------- データ読み込み ----------
with open(BLOG_DIR / "articles.json", encoding="utf-8") as f:
    all_articles = json.load(f)

# noindex 除外、日付降順
articles = [a for a in all_articles if not a["noindex"]]
articles.sort(key=lambda a: a["date"], reverse=True)

slug_to_idx = {a["slug"]: i for i, a in enumerate(articles)}


def related_html(current_slug, current_cat):
    """同カテゴリの新着3件（自記事除外）"""
    candidates = [a for a in articles if a["category"] == current_cat and a["slug"] != current_slug]
    picks = candidates[:3]
    if not picks:
        return ""

    cards = ""
    for a in picks:
        title_esc = a["title"].replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")
        excerpt = a["excerpt"][:60] + "…" if len(a["excerpt"]) > 60 else a["excerpt"]
        cards += f"""    <a href="{a['url']}" class="rel-card">
      <span class="rel-card-emoji">{a['emoji']}</span>
      <span class="rel-card-body">
        <span class="rel-card-title">{title_esc}</span>
        <span class="rel-card-excerpt">{excerpt}</span>
      </span>
    </a>\n"""

    return (
        "<!-- related-articles -->\n"
        '<section class="am-related">\n'
        '  <h2 class="am-related-title">関連記事</h2>\n'
        f'  <div class="rel-cards">\n{cards}  </div>\n'
        "</section>\n"
    )


def prevnext_html(current_slug):
    """日付順で前後の記事リンク"""
    idx = slug_to_idx.get(current_slug)
    if idx is None:
        return ""

    prev_art = articles[idx - 1] if idx > 0 else None          # 新しい記事
    next_art = articles[idx + 1] if idx < len(articles) - 1 else None  # 古い記事

    if not prev_art and not next_art:
        return ""

    parts = []
    if prev_art:
        t = prev_art["title"][:40] + "…" if len(prev_art["title"]) > 40 else prev_art["title"]
        parts.append(
            f'  <a class="pn-item pn-prev" href="{prev_art["url"]}">'
            f'<span class="pn-dir">← 新しい記事</span>'
            f'<span class="pn-title">{t}</span></a>'
        )
    else:
        parts.append('  <span class="pn-item pn-empty"></span>')

    if next_art:
        t = next_art["title"][:40] + "…" if len(next_art["title"]) > 40 else next_art["title"]
        parts.append(
            f'  <a class="pn-item pn-next" href="{next_art["url"]}">'
            f'<span class="pn-dir">古い記事 →</span>'
            f'<span class="pn-title">{t}</span></a>'
        )
    else:
        parts.append('  <span class="pn-item pn-empty"></span>')

    return (
        '<nav class="am-pn" aria-label="前後の記事">\n'
        + "\n".join(parts)
        + "\n</nav>\n"
    )


# ---------- 各記事を処理 ----------
updated = 0
skipped = 0

for article in articles:
    slug = article["slug"]
    html_path = BLOG_DIR / f"{slug}.html"
    if not html_path.exists():
        print(f"  SKIP (not found): {slug}.html")
        skipped += 1
        continue

    content = html_path.read_text(encoding="utf-8")

    # べき等チェック
    if "<!-- related-articles -->" in content:
        skipped += 1
        continue

    related = related_html(slug, article["category"])
    pn = prevnext_html(slug)

    # CTAボックスの直前に挿入（</article> の前のフッターCTA手前）
    insert_block = related + pn

    # </article> の直前に挿入
    if "</article>" in content:
        content = content.replace("</article>", insert_block + "</article>", 1)
    else:
        # フォールバック: am-cta-box の直前
        content = content.replace('<div class="am-cta-box">', insert_block + '<div class="am-cta-box">', 1)

    html_path.write_text(content, encoding="utf-8")
    updated += 1

print(f"完了: {updated}件更新, {skipped}件スキップ")

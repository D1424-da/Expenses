#!/usr/bin/env python3
"""
am-related（箇条書き）を section.related-articles / ra-grid / ra-card に変換。
また related-articles h3 の絵文字（📖）を除去して CSS 依存を排除。
"""

from bs4 import BeautifulSoup
import pathlib, re

ROOT = pathlib.Path(__file__).resolve().parents[1]
BLOG = ROOT / "static" / "blog"

# ターゲットページのカテゴリを取得するキャッシュ
_cat_cache: dict[str, str] = {}


def get_category(href: str) -> str:
    """href="/blog/xxx.html" → カテゴリ文字列"""
    if href in _cat_cache:
        return _cat_cache[href]
    fname = href.lstrip("/")  # "blog/xxx.html"
    p = ROOT / "static" / fname
    if not p.exists():
        return ""
    txt = p.read_text(encoding="utf-8", errors="ignore")
    m = re.search(r'class="am-cat"[^>]*>([^<]+)<', txt)
    if not m:
        m = re.search(r'class="article-category"[^>]*>([^<]+)<', txt)
    cat = m.group(1).strip() if m else ""
    _cat_cache[href] = cat
    return cat


def shorten_title(title: str) -> str:
    """ページタイトルから " - カケイシピ ブログ" などの suffix を除去して短縮"""
    title = re.sub(r'\s*[-‐–—]\s*カケイシピ.*$', '', title).strip()
    title = re.sub(r'\s*\|\s*カケイシピ.*$', '', title).strip()
    # 40文字を超える場合は適当な位置で切る
    if len(title) > 40:
        title = title[:38] + "…"
    return title


def build_related_section(links: list[tuple[str, str]]) -> str:
    """[(href, title), ...] → section.related-articles HTML"""
    cards = []
    for href, raw_title in links:
        cat = get_category(href)
        title = shorten_title(raw_title)
        tag_html = f'<span class="ra-tag">{cat}</span><br/>' if cat else ""
        cards.append(f'<a class="ra-card" href="{href}">{tag_html}{title}</a>')
    cards_html = "\n".join(cards)
    return (
        '<section class="related-articles">\n'
        '<h3>関連記事</h3>\n'
        '<div class="ra-grid">\n'
        f'{cards_html}\n'
        '</div>\n'
        '</section>'
    )


def fix_emoji_in_related(html: str) -> str:
    """section.related-articles h3 から絵文字を除去（□表示対策）"""
    return re.sub(
        r'(<h3>)[^\w<]*?(関連記事)(</h3>)',
        r'\1\2\3',
        html
    )


def convert_file(path: pathlib.Path) -> tuple[bool, str]:
    src = path.read_text(encoding="utf-8")
    soup = BeautifulSoup(src, "html.parser")
    changed = False

    # ① am-related → ra-grid 変換
    am_related = soup.find(class_="am-related")
    if am_related:
        links = []
        for a in am_related.find_all("a", href=True):
            links.append((a["href"], a.get_text(strip=True)))
        if links:
            new_html = build_related_section(links)
            am_related.replace_with(BeautifulSoup(new_html, "html.parser"))
            changed = True

    # ② h3 の絵文字除去
    result = str(soup)
    fixed = fix_emoji_in_related(result)
    if fixed != result:
        changed = True
        result = fixed

    if changed:
        path.write_text(result, encoding="utf-8", newline="\n")
        return True, "ok"
    return False, "no change"


def main():
    files = list(BLOG.glob("*.html"))
    ok = skip = 0
    for p in sorted(files):
        changed, msg = convert_file(p)
        if changed:
            print(f"  OK: {p.name}")
            ok += 1
        else:
            skip += 1
    print(f"\n完了: {ok}件変換 / {skip}件スキップ")


if __name__ == "__main__":
    main()

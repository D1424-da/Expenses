#!/usr/bin/env python3
"""
関連記事セクションがない記事に自動追加するスクリプト。
カテゴリが am-cat で取れない場合はタイトルから推定。
"""
import pathlib, re

ROOT = pathlib.Path(__file__).resolve().parents[1]
BLOG = ROOT / "static" / "blog"

# タイトルキーワード → カテゴリマッピング（am-cat がない場合のフォールバック）
KEYWORD_CAT = [
    (["節約レシピ", "食費", "節約料理"], "節約レシピ"),
    (["冷蔵庫", "冷蔵"], "レシピ管理"),
    (["レシピ管理", "レシピ記録"], "レシピ管理"),
    (["献立"], "献立"),
    (["家計簿", "家計管理"], "家計簿"),
    (["レシピ"], "節約レシピ"),
]

def guess_cat(title: str) -> str:
    for keywords, cat in KEYWORD_CAT:
        for kw in keywords:
            if kw in title:
                return cat
    return "ブログ"


def build_index():
    """href → (cat, title)、cat → [href, ...] の2つのマップを返す"""
    by_cat: dict[str, list[tuple[str, str]]] = {}
    for p in BLOG.glob("*.html"):
        txt = p.read_text(encoding="utf-8", errors="ignore")
        # am-cat から取得
        m = re.search(r'class="am-cat"[^>]*>([^<]+)<', txt)
        if m:
            cat = m.group(1).strip()
        else:
            # タイトルから推定
            tm = re.search(r'<title>([^<|]+)', txt)
            cat = guess_cat(tm.group(1).strip() if tm else "") if True else "ブログ"

        h1 = re.search(r'class="am-title"[^>]*>([\s\S]*?)</h1>', txt)
        if h1:
            title = re.sub(r'<[^>]+>', '', h1.group(1)).strip()
        else:
            tm = re.search(r'<title>([^<-]+)', txt)
            title = tm.group(1).strip() if tm else p.stem
        title = re.sub(r'\s+', ' ', title)
        if len(title) > 40:
            title = title[:38] + "…"

        by_cat.setdefault(cat, []).append((f"/blog/{p.name}", title))
    return by_cat


def build_related_html(cat: str, current: str, by_cat: dict, n=4) -> str:
    candidates = [(h, t) for h, t in by_cat.get(cat, []) if h != current][:n]
    if not candidates:
        return ""
    cards = "\n".join(
        f'<a class="ra-card" href="{h}"><span class="ra-tag">{cat}</span><br/>{t}</a>'
        for h, t in candidates
    )
    return (
        '\n<section class="related-articles">\n'
        '<h3>関連記事</h3>\n'
        '<div class="ra-grid">\n'
        f'{cards}\n'
        '</div>\n'
        '</section>'
    )


def fix_file(path: pathlib.Path, by_cat: dict) -> tuple[bool, str]:
    src = path.read_text(encoding="utf-8")
    if '<section class="related-articles">' in src:
        return False, "already has related"

    # カテゴリ特定
    m = re.search(r'class="am-cat"[^>]*>([^<]+)<', src)
    if m:
        cat = m.group(1).strip()
    else:
        tm = re.search(r'<title>([^<-]+)', src)
        cat = guess_cat(tm.group(1).strip() if tm else "")

    current = f"/blog/{path.name}"
    related_html = build_related_html(cat, current, by_cat)
    if not related_html:
        return False, f"no candidates for cat={cat}"

    # </main> の後ろ、または <footer> の前に挿入
    main_close = src.find('</main>')
    if main_close > 0:
        insert_at = main_close + len('</main>')
        src = src[:insert_at] + related_html + src[insert_at:]
    else:
        footer_pos = src.find('<footer')
        if footer_pos < 0:
            return False, "no insertion point"
        src = src[:footer_pos] + related_html + '\n' + src[footer_pos:]

    path.write_text(src, encoding="utf-8", newline="\n")
    return True, f"added (cat={cat})"


def main():
    print("インデックス構築中...")
    by_cat = build_index()

    ok = skip = 0
    for p in sorted(BLOG.glob("*.html")):
        changed, msg = fix_file(p, by_cat)
        if changed:
            print(f"  OK: {p.name} — {msg}")
            ok += 1
        else:
            skip += 1
    print(f"\n完了: {ok}件追加 / {skip}件スキップ")


if __name__ == "__main__":
    main()

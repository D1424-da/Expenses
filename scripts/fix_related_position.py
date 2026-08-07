#!/usr/bin/env python3
"""
2つの問題を一括修正:
1. related-articles が </main> 内にある → </main> の後ろに移動
2. related-articles が存在しない → 同カテゴリ記事から自動生成して挿入
"""

import pathlib, re

ROOT = pathlib.Path(__file__).resolve().parents[1]
BLOG = ROOT / "static" / "blog"

# カテゴリ → [（href, タイトル）, ...] の索引を先に構築
def build_index():
    index: dict[str, list[tuple[str, str]]] = {}
    for p in BLOG.glob("*.html"):
        txt = p.read_text(encoding="utf-8", errors="ignore")
        m = re.search(r'class="am-cat"[^>]*>([^<]+)<', txt)
        if not m:
            continue
        cat = m.group(1).strip()
        h1 = re.search(r'class="am-title"[^>]*>([\s\S]*?)</h1>', txt)
        if not h1:
            continue
        title = re.sub(r'<[^>]+>', '', h1.group(1)).strip()
        title = re.sub(r'\s+', ' ', title)
        if len(title) > 40:
            title = title[:38] + "…"
        index.setdefault(cat, []).append((f"/blog/{p.name}", title))
    return index


def build_related_html(cat: str, current_href: str, index: dict, n=4) -> str:
    candidates = [
        (href, title) for href, title in index.get(cat, [])
        if href != current_href
    ][:n]
    if not candidates:
        return ""
    cards = "\n".join(
        f'<a class="ra-card" href="{href}"><span class="ra-tag">{cat}</span><br/>{title}</a>'
        for href, title in candidates
    )
    return (
        '\n<section class="related-articles">\n'
        '<h3>関連記事</h3>\n'
        '<div class="ra-grid">\n'
        f'{cards}\n'
        '</div>\n'
        '</section>'
    )


def fix_file(path: pathlib.Path, index: dict) -> tuple[bool, str]:
    src = path.read_text(encoding="utf-8")
    changed = False

    # ① am-wrap 内にある related-articles を </main> の後ろへ移動
    # パターン: <section class="related-articles">...</section> が </main> より前
    rel_match = re.search(
        r'(<section class="related-articles">[\s\S]*?</section>)',
        src
    )
    main_close = src.find('</main>')
    if rel_match and main_close > 0 and rel_match.start() < main_close:
        block = rel_match.group(1)
        # 元の位置から削除（前後の余白も除去）
        src = src[:rel_match.start()].rstrip() + src[rel_match.end():]
        # </main> の後ろに挿入
        main_close_new = src.find('</main>')
        src = src[:main_close_new + len('</main>')] + '\n' + block + src[main_close_new + len('</main>'):]
        changed = True

    # ② related-articles が存在しない → 自動生成して挿入
    if '<section class="related-articles">' not in src:
        cat_m = re.search(r'class="am-cat"[^>]*>([^<]+)<', src)
        if cat_m:
            cat = cat_m.group(1).strip()
            current_href = f"/blog/{path.name}"
            related_html = build_related_html(cat, current_href, index)
            if related_html:
                # </main> の後ろに挿入（①が済んでいる場合もここに来る）
                main_close_pos = src.find('</main>')
                if main_close_pos > 0:
                    insert_at = main_close_pos + len('</main>')
                    src = src[:insert_at] + related_html + src[insert_at:]
                    changed = True

    if changed:
        path.write_text(src, encoding="utf-8", newline="\n")
        return True, "ok"
    return False, "no change"


def main():
    print("インデックス構築中...")
    index = build_index()
    print(f"カテゴリ数: {len(index)}")

    ok = skip = 0
    for p in sorted(BLOG.glob("*.html")):
        changed, msg = fix_file(p, index)
        if changed:
            print(f"  OK: {p.name}")
            ok += 1
        else:
            skip += 1
    print(f"\n完了: {ok}件修正 / {skip}件スキップ")


if __name__ == "__main__":
    main()

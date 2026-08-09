#!/usr/bin/env python3
"""
ブログ記事からNote投稿用テキストを生成する。
形式: 冒頭リード + 見出し一覧 + 元記事リンク誘導
"""
import json
import re
from pathlib import Path

BLOG_DIR = Path("/home/user/Expenses/static/blog")
OUTPUT_DIR = Path("/home/user/Expenses/note_posts")
BASE_URL = "https://get-tohon.online"

OUTPUT_DIR.mkdir(exist_ok=True)

with open(BLOG_DIR / "articles.json", encoding="utf-8") as f:
    all_articles = json.load(f)

articles = [a for a in all_articles if not a["noindex"]]
articles.sort(key=lambda a: a["date"], reverse=True)

# カテゴリ→Noteハッシュタグ対応
CATEGORY_TAGS = {
    "節約術":   ["節約", "家計管理", "食費節約"],
    "レシピ":   ["節約レシピ", "料理", "献立"],
    "買い物":   ["スーパー", "まとめ買い", "節約"],
    "家計":     ["家計簿", "家計管理", "節約"],
    "アプリ":   ["家計簿アプリ", "スマホ活用", "節約"],
}

def extract_h2s(html_path):
    """記事からh2見出しを抽出"""
    content = html_path.read_text(encoding="utf-8")
    h2s = re.findall(r'<h2[^>]*>([^<]+)</h2>', content)
    # TOC・まとめ・よくある質問は除く
    skip = {"まとめ", "よくある質問", "FAQ"}
    return [h for h in h2s if h not in skip][:5]

def make_note_post(article):
    slug = article["slug"]
    title = article["title"]
    excerpt = article["excerpt"]
    category = article["category"]
    emoji = article["emoji"]
    canonical = article["canonical"]
    date = article["date"]

    html_path = BLOG_DIR / f"{slug}.html"
    h2s = extract_h2s(html_path) if html_path.exists() else []

    tags = CATEGORY_TAGS.get(category, ["節約", "家計管理"])
    hashtags = "　".join(f"#{t}" for t in tags + ["カケイシピ"])

    # リード文（HTMLファイルからam-leadを取得、なければexcerptを使用）
    lead = excerpt
    html_path2 = BLOG_DIR / f"{slug}.html"
    if html_path2.exists():
        m = re.search(r'<p class="am-lead">(.*?)</p>', html_path2.read_text(encoding="utf-8"), re.DOTALL)
        if m:
            lead = re.sub(r'<[^>]+>', '', m.group(1)).strip()
    # 末尾を自然な文末に整える
    lead = re.sub(r'[。、…]+$', '', lead) + "。"

    # 見出し一覧
    toc_lines = ""
    if h2s:
        toc_lines = "\n".join(f"・{h}" for h in h2s)

    post = f"""{emoji} {title}

{lead}

この記事では以下の内容を詳しく解説しています👇

{toc_lines}

---

📖 続きは元記事でご覧ください
{canonical}

---

カケイシピは、レシートを撮るだけで食費を自動管理できる家計簿アプリです。
AIが食材からレシピも提案してくれるので、節約と献立の悩みを同時に解決できます。

👉 無料で試す → https://get-tohon.online/login.html

{hashtags}
"""
    return post.strip()

generated = 0
for article in articles:
    post = make_note_post(article)
    out_path = OUTPUT_DIR / f"{article['slug']}.txt"
    out_path.write_text(post, encoding="utf-8")
    generated += 1

print(f"完了: {generated}件のNote投稿用テキストを生成")
print(f"出力先: {OUTPUT_DIR}/")
print(f"\nサンプル（最初の1件）:")
print("=" * 60)
sample = sorted(OUTPUT_DIR.glob("*.txt"))[0]
print(sample.read_text(encoding="utf-8"))

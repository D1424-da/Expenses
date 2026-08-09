#!/usr/bin/env python3
"""
ブログ記事からNote投稿用テキストを生成する。
形式: 共感フック → 価値の先出し → 続きリンク → アプリ紹介
"""
import json
import re
from pathlib import Path

BLOG_DIR = Path(__file__).parent / "static/blog"
OUTPUT_DIR = Path(__file__).parent / "note_posts"
BASE_URL = "https://get-tohon.online"

OUTPUT_DIR.mkdir(exist_ok=True)

with open(BLOG_DIR / "articles.json", encoding="utf-8") as f:
    all_articles = json.load(f)

articles = [a for a in all_articles if not a["noindex"]]
articles.sort(key=lambda a: a["date"], reverse=True)

CATEGORY_TAGS = {
    "節約術":   ["節約", "家計管理", "食費節約"],
    "レシピ":   ["節約レシピ", "料理", "献立"],
    "買い物":   ["スーパー", "まとめ買い", "節約"],
    "家計":     ["家計簿", "家計管理", "節約"],
    "アプリ":   ["家計簿アプリ", "スマホ活用", "節約"],
}

def strip_tags(html):
    return re.sub(r'<[^>]+>', '', html).strip()

def extract_data(html_path):
    """記事から使える要素を抽出"""
    content = html_path.read_text(encoding="utf-8")

    # リード文
    m = re.search(r'<p class="am-lead">(.*?)</p>', content, re.DOTALL)
    lead = strip_tags(m.group(1)) if m else ""

    # h2セクション直後のp（具体的なデータ・説明を含む文）
    section_ps = re.findall(r'<h2[^>]*>.*?</h2>\s*<p>(.*?)</p>', content, re.DOTALL)
    tips = []
    for p in section_ps:
        clean = strip_tags(p).strip()
        # 数値や具体情報を含む文だけ採用
        if re.search(r'[0-9万円%円台]', clean) and 20 < len(clean) < 100:
            # 最初の文だけ取る
            sentence = clean.split("。")[0] + "。"
            tips.append(sentence)
        elif 20 < len(clean) < 80:
            tips.append(clean.split("。")[0] + "。")
        if len(tips) >= 2:
            break

    # tipが取れない場合はまとめのliを使う
    if not tips:
        summary_lis = re.findall(r'am-summary.*?<ul>(.*?)</ul>', content, re.DOTALL)
        if summary_lis:
            lis = re.findall(r'<li>(.*?)</li>', summary_lis[0], re.DOTALL)
            tips = [strip_tags(l).strip()[:70] for l in lis if 15 < len(strip_tags(l)) < 80][:2]

    # h2見出し
    h2s = re.findall(r'<h2[^>]*>([^<]+)</h2>', content)
    skip = {"まとめ", "よくある質問", "FAQ"}
    h2s = [h for h in h2s if h not in skip][:4]

    return lead, [], tips, h2s

def make_hook(lead, key_numbers):
    """共感・驚きを引き出す冒頭を組み立てる"""
    # リード文の最初の文だけ取り出す（。で区切る）
    first_sentence = lead.split("。")[0] + "。" if "。" in lead else lead[:60] + "…"
    return first_sentence

def make_note_post(article):
    slug = article["slug"]
    title = strip_tags(article["title"])
    category = article["category"]
    emoji = article["emoji"]
    canonical = article["canonical"]

    html_path = BLOG_DIR / f"{slug}.html"
    lead, key_numbers, tips, h2s = extract_data(html_path) if html_path.exists() else ("", [], [], [])

    tags = CATEGORY_TAGS.get(category, ["節約", "家計管理"])
    hashtags = "　".join(f"#{t}" for t in tags + ["カケイシピ"])

    hook = make_hook(lead, key_numbers)

    # ポイント先出し（数値データ or 具体的なtips）
    preview_lines = ""
    if key_numbers:
        preview_lines = "\n".join(f"▶ {n}" for n in key_numbers[:2])
    elif tips:
        preview_lines = "\n".join(f"▶ {t}" for t in tips[:2])

    # こんな人に読んでほしい（カテゴリ別）
    target_map = {
        "節約術": "食費を減らしたいけど何から始めればいいかわからない方",
        "レシピ": "毎日の献立に悩んでいる・食材を使い切れない方",
        "買い物": "スーパーで無駄買いしてしまう・食費がなぜか増える方",
        "家計":   "家計管理を始めたい・お金の流れを把握したい方",
        "アプリ": "家計簿が続かない・もっと手軽に管理したい方",
    }
    target = target_map.get(category, "食費・家計の管理に関心のある方")

    post = f"""{emoji} {title}

{hook}

📌 こんな方に読んでほしい
{target}

---

💡 この記事のポイント
{preview_lines if preview_lines else "詳しくは記事をご覧ください"}

---

📖 続きはこちらで無料公開中
{canonical}

---

カケイシピは、レシートを撮るだけで食費を自動記録できる無料アプリです。
AIが食材から献立も提案してくれるので、節約と料理の悩みを同時に解決できます。

👉 無料で試す → https://get-tohon.online/login.html

{hashtags}"""

    return post.strip()


# 投稿済みslugを読み込む（再生成時にpostedは上書きしない）
posted_dir = OUTPUT_DIR / "posted"
posted_slugs = {f.stem for f in posted_dir.glob("*.txt")} if posted_dir.exists() else set()

generated = 0
skipped = 0
for article in articles:
    slug = article["slug"]
    if slug in posted_slugs:
        skipped += 1
        continue
    post = make_note_post(article)
    out_path = OUTPUT_DIR / f"{slug}.txt"
    out_path.write_text(post, encoding="utf-8")
    generated += 1

print(f"生成: {generated}件 / スキップ（投稿済み）: {skipped}件")
print(f"\nサンプル:")
print("=" * 60)
sample = next(iter(sorted(OUTPUT_DIR.glob("*.txt"))), None)
if sample:
    print(sample.read_text(encoding="utf-8"))

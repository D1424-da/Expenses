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

# ── ハッシュタグ ────────────────────────────────────────────────────────
#
# note のハッシュタグは「そのタグのページに記事が並ぶ導線」で、
# note 内の回遊はここから生まれる。上限は10個。
#
# 以前は1記事あたり3〜4個しか付けておらず、しかも 135本中 129本が
# #節約 と #家計管理 だけという状態だった。原因は CATEGORY_TAGS の
# キー（"レシピ" "買い物" "家計" "アプリ"）が articles.json の実際の
# カテゴリ名（"献立・レシピ" "アプリ活用" "節約レシピ" など）と
# 一致しておらず、135本中97本が既定値に落ちていたこと。
#
# タグは3層で組み立てる。
#   1. 大分類 : note で母数が大きいタグ。露出の入口
#   2. 中分類 : 記事カテゴリに対応。関心の近い読者に当てる
#   3. 具体   : 記事固有。競合が少なくタグページ上位に出やすい
#
# ブランド名（#カケイシピ）は入れない。認知ゼロのタグを検索する人は
# おらず、1枠を捨てることになるため。ファンが付いてから検討する。

# 1. 大分類（どの記事にも付ける母数の大きいタグ）
BROAD_TAGS = ["節約", "家計管理", "暮らし"]

# 2. 中分類（articles.json の category と完全一致させること）
CATEGORY_TAGS = {
    "節約術":       ["食費節約", "節約術", "やりくり"],
    "家計管理":     ["家計簿", "家計簿アプリ", "貯金"],
    "献立・レシピ": ["献立", "レシピ", "料理", "おうちごはん"],
    "レシピ":       ["レシピ", "料理", "おうちごはん"],
    "節約レシピ":   ["節約レシピ", "献立", "料理"],
    "アプリ活用":   ["家計簿アプリ", "アプリ", "スマホ活用"],
    "ライフスタイル": ["暮らしの工夫", "ライフスタイル"],
    "その他":       ["食費", "節約生活"],
}

# 3. 具体（タイトル・スラッグに現れた語から付ける）
#    左のいずれかを含めば右のタグを足す。上から順に評価し、先に一致した
#    ものを優先する（世帯構成 → 場面 → 手法 の順に具体的）。
KEYWORD_TAGS = [
    (["一人暮らし", "solo", "hitori", "ひとり"], ["一人暮らし", "自炊"]),
    (["二人暮らし", "futari", "同棲", "カップル", "夫婦", "couple"], ["二人暮らし", "共働き"]),
    (["4人家族", "family4", "家族", "子育て", "kosodate"], ["子育て", "家族"]),
    (["60代", "高齢", "シニア", "koureisha"], ["シニア", "年金生活"]),
    (["弁当", "bento", "obento"], ["お弁当", "弁当作り"]),
    (["朝ごはん", "朝食", "asagohan"], ["朝ごはん"]),
    (["夕飯", "夕食", "晩御飯", "yuhan", "dinner"], ["夕飯"]),
    (["作り置き", "tsukurioki"], ["作り置き", "常備菜"]),
    (["まとめ買い", "matomegai"], ["まとめ買い", "買い物"]),
    (["冷蔵庫", "reizoko", "fridge"], ["冷蔵庫", "食材管理"]),
    (["冷凍", "reito"], ["冷凍保存"]),
    (["スーパー", "supermarket", "業務スーパー", "gyoumu"], ["スーパー", "買い物術"]),
    (["レシート", "receipt", "ocr"], ["レシート", "家計簿アプリ"]),
    (["ai", "AI"], ["AI活用"]),
    (["時短", "簡単", "jitan", "quick", "5分", "ズボラ"], ["時短", "時短レシピ"]),
    (["ダイエット", "diet", "タンパク質", "protein"], ["ダイエット"]),
    (["カレー", "curry", "ハンバーグ", "hambag", "うどん", "udon"], ["定番レシピ"]),
    (["excel", "エクセル", "csv", "テンプレート"], ["効率化"]),
    (["買い物", "shopping"], ["買い物"]),
    (["レシピ", "recipe", "献立", "kondate"], ["レシピ", "料理"]),
    (["食費", "shokuhi", "food-cost"], ["食費", "食費節約"]),
]

MAX_TAGS = 10  # note の上限


def build_hashtags(article):
    """記事に合わせて8〜10個のハッシュタグを組み立てる。

    同じタグばかりになると、自分の記事同士が同じタグページで競合して
    読者層が広がらない。3層に分けて、記事ごとに違う入口を作る。
    """
    tags: list[str] = []

    def add(names):
        for n in names:
            if n not in tags and len(tags) < MAX_TAGS:
                tags.append(n)

    # 中分類を先に入れる（記事との関連が最も強い）
    add(CATEGORY_TAGS.get(article["category"], CATEGORY_TAGS["その他"]))

    # 具体タグ。タイトルとスラッグの両方から探す
    haystack = (article["title"] + " " + article["slug"]).lower()
    for keywords, extra in KEYWORD_TAGS:
        if any(k.lower() in haystack for k in keywords):
            add(extra)

    # 最後に大分類で埋める（枠が余っていれば）
    add(BROAD_TAGS)
    return tags

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

    hashtags = "　".join(f"#{t}" for t in build_hashtags(article))

    hook = make_hook(lead, key_numbers)

    # ポイント先出し（数値データ or 具体的なtips）
    preview_lines = ""
    if key_numbers:
        preview_lines = "\n".join(f"▶ {n}" for n in key_numbers[:2])
    elif tips:
        preview_lines = "\n".join(f"▶ {t}" for t in tips[:2])

    # こんな人に読んでほしい（カテゴリ別）
    # キーは articles.json の category と完全一致させること。
    # 以前は "レシピ" "買い物" "家計" "アプリ" という実在しないキーで、
    # 135本中97本が既定文に落ちていた（CATEGORY_TAGS と同じ原因）。
    target_map = {
        "節約術":       "食費を減らしたいけど何から始めればいいかわからない方",
        "家計管理":     "家計管理を始めたい・お金の流れを把握したい方",
        "献立・レシピ": "毎日の献立に悩んでいる・食材を使い切れない方",
        "レシピ":       "毎日の献立に悩んでいる・食材を使い切れない方",
        "節約レシピ":   "安く作れて満足感のある料理を知りたい方",
        "アプリ活用":   "家計簿が続かない・もっと手軽に管理したい方",
        "ライフスタイル": "暮らしの無駄を減らして気持ちよく暮らしたい方",
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

# 統合済み（noindex）になった記事の下書きを消す。
# 記事を統合すると 301 で別記事へ飛ぶため、そのまま投稿すると読者が
# 意図しないページに着地する。articles から除外されるだけでは
# 過去に生成したファイルが残り続けるので、ここで掃除する。
live_slugs = {a["slug"] for a in articles}
removed = 0
for f in OUTPUT_DIR.glob("*.txt"):
    if f.stem not in live_slugs and f.stem not in posted_slugs:
        f.unlink()
        removed += 1
if removed:
    print(f"統合済み記事の下書きを削除: {removed}件")

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

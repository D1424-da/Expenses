#!/usr/bin/env python3
"""note の投稿順を決めて note_posts/投稿計画.md に書き出す。

外部リンクがゼロのままインデックスが進まないので、note からの被リンクが
唯一動かせるレバーになっている。ただし130本を順不同で出しても効かない。
**どの記事にリンクを集めるか**で効果が変わる。

優先順位は3段階。

  1. 統合の集約先（15本）
     統合元35本の評価が301で集まる先。本文も 6,200〜15,200字あり、
     Google に「薄い」と切られにくい。sitemap の priority も 0.8。
  2. HIGH_PRIORITY_SLUGS の重点記事
     10位以内でクリックがある記事と、内部リンクが集まるハブ。
  3. それ以外（本文の長い順）

投稿済み（note_posts/posted/）は除外する。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BLOG = ROOT / "static" / "blog"
NOTE = ROOT / "note_posts"
OUT = NOTE / "投稿計画.md"

# 統合の集約先。scripts/merge_articles.py で統合先に指定したもの。
TARGETS = [
    "solo-food-cost", "family4-food-cost", "weekly-meal-plan",
    "tsukurioki-weekly-plan", "meal-plan-today", "bento-okazu-simple",
    "food-cost-savings-tips", "savings-life", "shopping-list-auto",
    "fridge-ai-recipe", "kakeibo-app-compare", "excel-kakeibo-auto",
    "food-cost-only-app", "simple-kakeibo-continue", "recipe-record-app",
]


def high_priority() -> set[str]:
    src = (ROOT / "build_blog.py").read_text(encoding="utf-8")
    body = re.search(r"HIGH_PRIORITY_SLUGS = \{(.*?)\n\}", src, re.S)
    return set(re.findall(r'"([^"]+)"', body.group(1))) if body else set()


def body_length(slug: str) -> int:
    html = (BLOG / f"{slug}.html").read_text(encoding="utf-8")
    html = re.sub(r"<script.*?</script>|<style.*?</style>", "", html, flags=re.S)
    return len(re.sub(r"\s+", "", re.sub(r"<[^>]+>", "", html)))


def main() -> None:
    articles = json.loads((BLOG / "articles.json").read_text(encoding="utf-8"))
    posted = {p.stem for p in (NOTE / "posted").glob("*.txt")}
    drafts = {p.stem for p in NOTE.glob("*.txt")}
    hp = high_priority()

    rows = []
    for a in articles:
        slug = a["url"].split("/")[-1].removesuffix(".html")
        if a.get("noindex") or slug in posted:
            continue
        tier = 1 if slug in TARGETS else (2 if slug in hp else 3)
        rows.append((tier, -body_length(slug), slug, a))

    rows.sort()
    label = {1: "統合先", 2: "重点", 3: ""}

    lines = [
        "# note 投稿計画",
        "",
        "`python3 scripts/note_plan.py` で再生成する。編集しても次回上書きされる。",
        "",
        "統合の集約先を先に出す。統合元35本の評価が301で集まるうえ本文も厚いので、",
        "同じ1本の被リンクでも効き方が違う。",
        "",
        f"未投稿 {len(rows)}本 / 投稿済み {len(posted)}本",
        "",
        "| # | 記事 | 本文 | カテゴリ | 区分 | 下書き |",
        "|---|---|---|---|---|---|",
    ]
    for i, (tier, neg, slug, a) in enumerate(rows, 1):
        title = re.sub(r"<[^>]+>", " ", a["title"]).strip()
        mark = "○" if slug in drafts else "**×**"
        lines.append(
            f"| {i} | `{slug}` {title} | {-neg:,}字 | {a['category']} "
            f"| {label[tier]} | {mark} |"
        )
    lines.append("")
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{OUT} に {len(rows)}本を書き出した")


if __name__ == "__main__":
    main()

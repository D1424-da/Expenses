"""記事タイトルがページ内・サイト内で食い違っていないかの検証。

実際に起きた事故:
  60dai-fuufu-shokuhi.html は、title / h1 / description / og:title が
  「定年後に月5〜6万円台」、本文のリード・目次・h2・articles.json・
  他記事からの参照34箇所が「月3〜4万円台」になっていた。
  5〜6万円台は総務省の平均値で、記事が目標として掲げているのは
  3〜4万円台。検索結果に出る見出しだけが別の数字を示していた。

articles.json のタイトルは一覧カード・関連記事・前後ナビに使われ、
h1 は記事ページの見出しになる。両者がずれると、カードをクリックした
読者が別の内容のページに来たように感じる。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

BLOG = Path(__file__).resolve().parent.parent / "static" / "blog"


def _norm(s: str) -> str:
    """タグ・記号・空白を落として比較用に正規化する。

    h1 は改行に <br/> を使い、articles.json は同じ位置に ｜ を使うなど
    表記が揺れるため、意味に関係しない文字を除く。
    """
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"\s*[-|｜]\s*カケイシピ(\s*ブログ)?\s*$", "", s.strip())
    return re.sub(r"[\s｜|]+", "", s)


def _articles() -> list[Path]:
    return sorted(BLOG.glob("*.html"))


def _meta() -> dict[str, dict]:
    data = json.loads((BLOG / "articles.json").read_text(encoding="utf-8"))
    return {a["url"].rsplit("/", 1)[-1]: a for a in data}


def _first(pattern: str, text: str) -> str | None:
    m = re.search(pattern, text, re.S)
    return m.group(1) if m else None


def test_head_titles_are_consistent():
    """title / og:title / twitter:title / JSON-LD headline が一致する。

    検索結果・SNSシェア・リッチリザルトで違う見出しが出るのを防ぐ。
    """
    problems = []
    for p in _articles():
        html = p.read_text(encoding="utf-8")
        head = html.split("</head>")[0]
        title = _first(r"<title>(.*?)</title>", head)
        if not title:
            continue
        expected = _norm(title)

        for tag in re.findall(r"<meta\b[^>]*>", head):
            for key in ("og:title", "twitter:title"):
                if f'"{key}"' in tag or f"'{key}'" in tag:
                    c = _first(r'content=["\']([^"\']*)["\']', tag)
                    if c and _norm(c) != expected:
                        problems.append(f"{p.name}: {key}")

        for block in re.findall(
            r'<script type="application/ld\+json">(.*?)</script>', head, re.S
        ):
            data = json.loads(block)
            for o in data if isinstance(data, list) else [data]:
                if isinstance(o, dict) and o.get("@type") in ("Article", "BlogPosting"):
                    if _norm(o.get("headline", "")) != expected:
                        problems.append(f"{p.name}: JSON-LD headline")

    assert not problems, "head 内のタイトルが不一致: " + ", ".join(problems[:20])


def test_h1_matches_articles_json_title():
    """h1 が articles.json のタイトルで始まる。

    完全一致は求めない。一覧カード用に短く切ったタイトルを持つ記事が
    あり（saving-recipe-* など）、それ自体は問題ないため。
    禁じたいのは「同じ記事なのに違うことを言っている」ケース。
    """
    meta = _meta()
    problems = []
    for p in _articles():
        m = meta.get(p.name)
        if not m:
            continue
        h1 = _first(r"<h1[^>]*>(.*?)</h1>", p.read_text(encoding="utf-8"))
        if not h1:
            continue
        if not _norm(h1).startswith(_norm(m["title"])):
            problems.append(
                f"{p.name}\n    articles.json: {_norm(m['title'])}\n    h1           : {_norm(h1)}"
            )
    assert not problems, "articles.json のタイトルと h1 が食い違う:\n  " + "\n  ".join(
        problems[:10]
    )


def test_title_and_h1_do_not_contradict_on_numbers():
    """title と h1 が違う数字を主張していない。

    60dai の事故はここで検出できる（title が月5〜6万円台、
    h1 が月3〜4万円台という状態）。
    """
    num = re.compile(r"\d+(?:[〜~ー-]\d+)?(?:万|円|分|選|日|週間|%)")
    problems = []
    for p in _articles():
        html = p.read_text(encoding="utf-8")
        title = _first(r"<title>(.*?)</title>", html)
        h1 = _first(r"<h1[^>]*>(.*?)</h1>", html)
        if not (title and h1):
            continue
        def by_unit(text: str) -> dict[str, set[str]]:
            out: dict[str, set[str]] = {}
            for m in num.finditer(_norm(text)):
                unit = re.sub(r"^[\d〜~ー-]+", "", m.group())
                out.setdefault(unit, set()).add(m.group())
            return out

        t_by, h_by = by_unit(title), by_unit(h1)
        # h1 が数字に触れていない単位は許容する。片方だけが具体値を
        # 挙げているのは矛盾ではない（例:「11のテクニックを完全公開」）。
        # 同じ単位について違う値を主張している場合だけを問題とする。
        for unit, t_vals in t_by.items():
            h_vals = h_by.get(unit)
            if h_vals and not (t_vals & h_vals):
                problems.append(
                    f"{p.name}: title={sorted(t_vals)} / h1={sorted(h_vals)}"
                )
    assert not problems, "title と h1 の数字が食い違う: " + "; ".join(problems[:10])

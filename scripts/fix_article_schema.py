"""記事HTMLの Article / BlogPosting 構造化データを正規化する。

背景:
  記事は135本あり、JSON-LD は執筆時期によって書式がばらついていた。
  点検したところ次の欠落があった。

    image         : 135件（全記事）… Google の Article 構造化データで必須
    description   : 34件
    author        : 31件            … E-E-A-T の直接的なシグナル
    dateModified  : 32件
    datePublished : 25件

  さらに @type が BlogPosting 76件 / Article 59件 と混在していた。

  記事HTMLは build_blog.py では再生成されない（build_blog.py が作るのは
  一覧・カテゴリ・サイトマップのみ）ため、このスクリプトで一括修正する。

使い方:
    python3 scripts/fix_article_schema.py          # 書き換える
    python3 scripts/fix_article_schema.py --check  # 差分の有無だけ確認

不足分を補うのが目的なので、既に入っている値は上書きしない
（headline や description は記事ごとに調整されているため）。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BLOG = ROOT / "static" / "blog"
BASE_URL = "https://get-tohon.online"

# 記事ごとのOGP画像は用意していないため、サイト共通の画像を使う。
# Article の image は必須項目なので、共通画像でも入れておく方がよい。
DEFAULT_IMAGE = f"{BASE_URL}/ogp.png"

AUTHOR = {"@type": "Organization", "name": "カケイシピ編集部"}
PUBLISHER = {"@type": "Organization", "name": "カケイシピ", "url": f"{BASE_URL}/"}

# 混在していた @type を統一する。ブログ記事なので BlogPosting が適切
# （BlogPosting は Article のサブタイプで、要求される項目は同じ）。
CANONICAL_TYPE = "BlogPosting"

LD_RE = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)


def load_meta() -> dict[str, dict]:
    data = json.loads((BLOG / "articles.json").read_text(encoding="utf-8"))
    return {a["url"].rsplit("/", 1)[-1]: a for a in data}


def page_title(html: str) -> str:
    m = re.search(r"<title>(.*?)</title>", html, re.S)
    return m.group(1).strip() if m else ""


def page_description(html: str) -> str:
    for tag in re.findall(r"<meta\b[^>]*>", html.split("</head>")[0]):
        if re.search(r'name=["\']description["\']', tag):
            m = re.search(r'content=["\']([^"\']*)["\']', tag)
            if m:
                return m.group(1).strip()
    return ""


def normalize(obj: dict, fname: str, html: str, meta: dict | None) -> dict:
    """Article/BlogPosting オブジェクトに欠けている項目を補う。"""
    obj["@type"] = CANONICAL_TYPE
    url = (meta or {}).get("canonical") or f"{BASE_URL}/blog/{fname}"

    obj.setdefault("headline", (meta or {}).get("title") or page_title(html))
    desc = page_description(html) or (meta or {}).get("excerpt", "")[:150]
    if not obj.get("description") and desc:
        obj["description"] = desc
    obj.setdefault("image", DEFAULT_IMAGE)
    obj.setdefault("author", AUTHOR)
    obj["publisher"] = PUBLISHER
    obj.setdefault("url", url)
    # 検索結果の日付表示と「どのページの記事か」の紐付けに使われる。
    date = (meta or {}).get("date")
    if date:
        obj.setdefault("datePublished", date)
    obj.setdefault("dateModified", obj.get("datePublished", date) or date)
    obj.setdefault("mainEntityOfPage", {"@type": "WebPage", "@id": url})
    obj.setdefault("inLanguage", "ja")
    # 値が None のまま残らないようにする（JSON-LD として無効になるため）
    return {k: v for k, v in obj.items() if v is not None}


def process(path: Path, meta_by_file: dict[str, dict]) -> str | None:
    """書き換え後のHTMLを返す。変更が無ければ None。"""
    html = path.read_text(encoding="utf-8")
    meta = meta_by_file.get(path.name)
    out = html
    changed = False

    for block in LD_RE.findall(html):
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            print(f"  !! JSON-LD が壊れている: {path.name}")
            continue
        objs = data if isinstance(data, list) else [data]
        if not any(
            isinstance(o, dict) and o.get("@type") in ("Article", "BlogPosting")
            for o in objs
        ):
            continue
        new_objs = [
            normalize(o, path.name, html, meta)
            if isinstance(o, dict) and o.get("@type") in ("Article", "BlogPosting")
            else o
            for o in objs
        ]
        new_data = new_objs if isinstance(data, list) else new_objs[0]
        new_block = json.dumps(new_data, ensure_ascii=False, separators=(",", ":"))
        if new_block != block.strip():
            out = out.replace(block, new_block, 1)
            changed = True

    return out if changed else None


def main() -> int:
    check = "--check" in sys.argv
    meta_by_file = load_meta()
    files = sorted(BLOG.glob("*.html"))
    changed = []
    for f in files:
        new = process(f, meta_by_file)
        if new is None:
            continue
        changed.append(f.name)
        if not check:
            f.write_text(new, encoding="utf-8")

    verb = "要修正" if check else "修正"
    print(f"{len(files)}記事中 {len(changed)}件を{verb}")
    if check and changed:
        for n in changed[:10]:
            print(f"  {n}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""articles.json の searchExclude を、記事HTMLの meta robots に反映する。

## なぜ必要か

2026-08、Google のインデックス数が 18→14 と減り続け、インデックス登録を
リクエストしても登録されない状態になった。手動による対策は無し。
公開94記事のうち76%が3,500〜5,500字の狭い帯に収まる**テンプレート量産**で、
サイト単位で低く評価されていると判断した（運営者の承認済み）。

そこで、実質的な内容を持つ少数の記事だけを検索対象に残し、残りは
**noindex にする（削除はしない）**。サイト内では今までどおり読める。

## noindex と searchExclude の違い

- `noindex: true`  … 統合で消えた記事。firebase.json の 301 と canonical で
  処理済みなので **HTML に meta noindex は入れない**
  （canonical と noindex の併用は Google が非推奨）
- `searchExclude: true` … 公開したまま検索対象から外す記事。
  **HTML に meta robots noindex,follow を入れる**。
  `follow` にするのは、記事内から他記事へのリンクを辿ってほしいため。

## 使い方

    python3 scripts/apply_search_exclude.py           # 反映する
    python3 scripts/apply_search_exclude.py --check   # 差分があれば終了コード1

反映後は build_blog.py を実行すること（一覧・サイトマップから外れる）。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BLOG = ROOT / "static" / "blog"
ARTICLES = BLOG / "articles.json"

TAG = '<meta content="noindex, follow" name="robots"/>'
# 既に入っている robots メタ（属性の順序は記事によって違う）
_ROBOTS_RE = re.compile(r'\s*<meta[^>]*name="robots"[^>]*/?>\s*', re.I)


def _load() -> list[dict]:
    return json.loads(ARTICLES.read_text(encoding="utf-8"))


def _apply(path: Path, want: bool) -> bool:
    """記事HTMLの robots メタを want に合わせる。変更したら True。"""
    src = path.read_text(encoding="utf-8")
    has = bool(_ROBOTS_RE.search(src))
    if want == has:
        return False

    if want:
        # <title> の直前に置く。head の先頭付近であればどこでもよいが、
        # 位置を固定しておくと差分が読みやすい。
        m = re.search(r"<title>", src)
        if not m:
            print(f"  !! <title> が無い: {path.name}")
            return False
        out = src[: m.start()] + TAG + "\n" + src[m.start() :]
    else:
        out = _ROBOTS_RE.sub("\n", src, count=1)

    path.write_text(out, encoding="utf-8")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="変更せず差分の有無だけ返す")
    args = ap.parse_args()

    changed: list[str] = []
    for a in _load():
        # 統合済み（noindex）は 301 と canonical で処理する。触らない。
        if a.get("noindex"):
            continue
        path = BLOG / f"{a['slug']}.html"
        if not path.exists():
            print(f"  !! HTML が無い: {a['slug']}")
            continue
        want = bool(a.get("searchExclude"))
        if args.check:
            src = path.read_text(encoding="utf-8")
            if want != bool(_ROBOTS_RE.search(src)):
                changed.append(a["slug"])
        elif _apply(path, want):
            changed.append(a["slug"])

    if args.check:
        if changed:
            print(f"articles.json と meta robots が食い違う記事 {len(changed)}件:")
            for s in changed[:20]:
                print(f"  {s}")
            return 1
        print("meta robots は articles.json と一致しています。")
        return 0

    print(f"{len(changed)}件の記事の meta robots を更新しました。")
    print("続けて python3 build_blog.py を実行してください。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

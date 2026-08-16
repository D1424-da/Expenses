#!/usr/bin/env python3
"""記事を統合する（統合元の固有セクションを統合先へ移し、301 と canonical を張る）。

Search Console の「クロール済み - インデックス未登録」に74ページが積み上がった
のがきっかけ。本文の文字数を測ったところ、記事64本すべてが 3,900〜5,200字の
範囲に収まっていた。テンプレートで量産した均質な記事の群れは、Google に
「読んだが載せる価値なし」と判断される。数を減らすこと自体が目的ではなく、
**薄い記事を厚い記事に変える**のが目的なので、統合元の本文は捨てずに
統合先へ移す。

1件の統合で必要な操作は5つある。手作業だと必ずどれかを忘れるため、
このスクリプトが 1〜4 をまとめて行う（5 は build_blog.py）。

  1. 統合先に、統合元の固有セクションを追記する（目次も更新）
  2. 統合元の HTML に統合先への canonical を置く
  3. static/blog/articles.json で統合元を noindex: true にする
  4. firebase.json の redirects に 301 を足す
  5. build_blog.py で一覧・カテゴリ・sitemap を再生成する

HTML は消さない。Hosting は redirects を静的ファイルより先に評価するので、
firebase.json から1行消せば統合を巻き戻せる（既存の統合と同じ方針）。

使い方:
    python3 scripts/merge_articles.py <統合先スラッグ> <統合元スラッグ>...
    python3 scripts/merge_articles.py --plan   # 計画ファイルを一括実行
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BLOG = ROOT / "static" / "blog"
ARTICLES = BLOG / "articles.json"
FIREBASE = ROOT / "firebase.json"
BASE = "https://get-tohon.online"

# 統合日。統合先は本文が大きく変わるので、更新日として articles.json に残し、
# サイトマップの lastmod に反映させる（公開日 date は書き換えない）。
TODAY = "2026-08-16"

# 統合先へ移さないセクション。どの記事にも同じ趣旨で存在するため、
# そのまま移すと統合先に「まとめ」が3つ並ぶ。
SKIP_HEADINGS = ("まとめ", "よくある質問", "関連記事", "この記事のポイント")

# 統合先に同じ話題の見出しが既にあるかの判定に使う。表記ゆれを吸収するため、
# 記号と空白を落としてから比較する。
_NORM = re.compile(r"[\s　・！？「」（）()\[\]【】｜|:：/、。,.\-–—…]+")


def _norm(text: str) -> str:
    return _NORM.sub("", re.sub(r"<[^>]+>", "", text)).lower()


def _headings(html: str) -> set[str]:
    return {_norm(m) for m in re.findall(r"<h[23][^>]*>(.*?)</h[23]>", html, re.S)}


def _sections(html: str) -> list[tuple[str, str, str]]:
    """(id, 見出しテキスト, HTML断片) を h2 単位で返す。

    記事テンプレートは1種類ではない（<article class="am"> のものと
    .article-wrap で包むものがある）が、h2 の切り出しは共通で使える。
    """
    out = []
    marks = list(re.finditer(r'<h2(?:\s[^>]*)?>', html))
    for n, m in enumerate(marks):
        end = marks[n + 1].start() if n + 1 < len(marks) else len(html)
        chunk = html[m.start():end]
        title = re.search(r"<h2[^>]*>(.*?)</h2>", chunk, re.S)
        hid = re.search(r'id="([^"]+)"', m.group(0))
        if not title:
            continue
        out.append((hid.group(1) if hid else "", title.group(1).strip(), chunk))
    return out


# 記事の器になっているタグ。h2 で機械的に切ると、切れ目をまたいで
# 開いたまま／閉じたままのものが必ず出る。
_CONTAINERS = ("section", "div", "article", "main", "nav", "aside")


def _balance(chunk: str) -> str:
    """h2 で切った断片のタグ収支を合わせる。

    最初の実装では「開きより閉じが多いタグを全部消す」としていたが、
    それだと断片の途中にある正当な </div> まで落ちて、統合先の div が
    8個開きっぱなしになった。開きを持たない**末尾側の**閉じタグだけを
    落とし、閉じられていない開きタグは末尾で閉じる。
    """
    # 記事内CTA は blog-cta.js が統合先のものを差し替えるので持ち込まない。
    chunk = re.sub(r'<div class="am-cta-box".*', "", chunk, flags=re.S)
    # 統合元の目次を持ち込まない。導入部に h2 を置く記事があり、その h2 で
    # 切ると目次まで断片に入ってしまう。移した先には統合元の見出し id が
    # 存在しないため、リンク切れのアンカーが生まれる（実際に6本で発生した）。
    chunk = re.sub(r'<nav class="am-toc">.*?</nav>', "", chunk, flags=re.S)

    tokens = list(re.finditer(r"<(/?)(" + "|".join(_CONTAINERS) + r")(?=[\s>/])[^>]*>", chunk))
    stack: list[str] = []
    drop: list[tuple[int, int]] = []
    for m in tokens:
        closing, name = m.group(1), m.group(2)
        if not closing:
            if not m.group(0).rstrip().endswith("/>"):
                stack.append(name)
        elif stack and stack[-1] == name:
            stack.pop()
        else:
            drop.append(m.span())      # 対応する開きが断片内に無い閉じタグ
    for start, end in reversed(drop):
        chunk = chunk[:start] + chunk[end:]
    # 閉じられずに残った開きタグを、内側から順に閉じる。
    chunk = chunk.rstrip() + "".join(f"</{n}>" for n in reversed(stack))
    return chunk


def _anchor(src: str, hid: str, seq: int) -> str:
    """URL に置ける安全なアンカー名を作る。

    見出し id には日本語や & を含むものがある（"料理のよくある疑問Q&A" など）。
    そのまま href に置くと HTML として壊れるので、安全な文字だけ残し、
    残らなければ連番にする。
    """
    safe = re.sub(r"[^A-Za-z0-9_-]", "", hid or "")
    return f"{src}-{safe or seq}"


def merge(target: str, sources: list[str]) -> None:
    tpath = BLOG / f"{target}.html"
    thtml = tpath.read_text(encoding="utf-8")
    existing = _headings(thtml)

    added: list[tuple[str, str]] = []   # (アンカー, 見出し)
    blocks: list[str] = []

    for src in sources:
        spath = BLOG / f"{src}.html"
        shtml = spath.read_text(encoding="utf-8")
        for hid, title, chunk in _sections(shtml):
            plain = re.sub(r"<[^>]+>", "", title).strip()
            if any(k in plain for k in SKIP_HEADINGS):
                continue
            if _norm(title) in existing:
                continue          # 同じ話題が統合先に既にある
            # id の衝突を避けるため統合元スラッグを前置する。
            anchor = _anchor(src, hid, len(added))
            chunk = chunk.replace(f'id="{hid}"', f'id="{anchor}"', 1) if hid else \
                chunk.replace("<h2", f'<h2 id="{anchor}"', 1)
            blocks.append(_balance(chunk))
            added.append((anchor, plain))
            existing.add(_norm(title))

        # 統合元に canonical を張る（既にあれば差し替え）。
        canon = f'<link href="{BASE}/blog/{target}.html" rel="canonical"/>'
        if re.search(r'<link[^>]*rel="canonical"[^>]*/?>', shtml):
            shtml = re.sub(r'<link[^>]*rel="canonical"[^>]*/?>', canon, shtml, count=1)
        else:
            shtml = shtml.replace("</head>", f"  {canon}\n</head>", 1)
        # noindex は入れない。canonical との併用は Google が非推奨で、
        # noindex を読ませると統合先への評価の受け渡しが起きない。
        spath.write_text(shtml, encoding="utf-8")
        print(f"  canonical: {src} → {target}")

    if blocks:
        body = "\n".join(f"<section>\n{b}\n</section>" for b in blocks)
        # まとめの直前に差し込む。まとめが無い記事では末尾の関連記事の前。
        for marker in ('<div class="am-summary">', '<h2 id="related"', "<footer"):
            if marker in thtml:
                thtml = thtml.replace(marker, body + "\n" + marker, 1)
                break
        else:
            raise SystemExit(f"{target}: 差し込み位置が見つからない")

        # 目次にも足す。目次が無いテンプレートもあるので、あるときだけ。
        toc = "\n".join(f'<li><a href="#{a}">{t}</a></li>' for a, t in added)
        if "</ol>\n</nav>" in thtml:
            thtml = thtml.replace("</ol>\n</nav>", toc + "\n</ol>\n</nav>", 1)
        tpath.write_text(thtml, encoding="utf-8")
        print(f"  {target}: {len(added)}セクション追記")

    # articles.json: 統合元を noindex にし（サイトマップから外れる）、
    # canonical も統合先へ向ける。
    # articles.json の canonical は scripts/fix_article_schema.py が
    # 構造化データの url に使う。ここを直さないと、あとで同スクリプトを
    # 走らせたときに HTML 側の canonical が自分自身へ巻き戻る。
    arts = json.loads(ARTICLES.read_text(encoding="utf-8"))
    for a in arts:
        slug = a["url"].split("/")[-1].removesuffix(".html")
        if slug in sources:
            a["noindex"] = True
            a["canonical"] = f"{BASE}/blog/{target}.html"
        elif slug == target:
            # 本文が増えたことを sitemap の lastmod に伝える。
            a["updated"] = TODAY
    ARTICLES.write_text(
        json.dumps(arts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    # firebase.json: 301 を足す。統合元が既に別記事の301受け先になっている
    # 場合はリダイレクトが連鎖するので、その301も新しい統合先へ張り替える。
    cfg = json.loads(FIREBASE.read_text(encoding="utf-8"))
    reds = cfg["hosting"]["redirects"]
    dest = f"/blog/{target}.html"
    for src in sources:
        s = f"/blog/{src}.html"
        for r in reds:
            if r["destination"] == s:
                r["destination"] = dest
                # 301 だけ張り替えると canonical と食い違う。
                # tests/test_sitemap.py が「301の宛先＝canonical」を守っている。
                old = BLOG / Path(r["source"]).name
                if old.is_file():
                    old.write_text(
                        re.sub(
                            r'<link[^>]*rel="canonical"[^>]*/?>',
                            f'<link href="{BASE}/blog/{target}.html" rel="canonical"/>',
                            old.read_text(encoding="utf-8"), count=1,
                        ),
                        encoding="utf-8",
                    )
                print(f"  301連鎖を解消: {r['source']} → {dest}")
        if not any(r["source"] == s for r in reds):
            reds.append({"source": s, "destination": dest, "type": 301})
    FIREBASE.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def fix_links() -> None:
    """統合で 301 になった URL への内部リンクを、最終地点へ張り替える。

    リダイレクトを1回はさむぶんクロールを無駄にする。統合のたびに
    「関連記事」から古い URL を指したままになるので、統合後に必ず通す。
    tests/test_internal_links.py が守っている。
    """
    cfg = json.loads(FIREBASE.read_text(encoding="utf-8"))
    hop = {r["source"]: r["destination"] for r in cfg["hosting"]["redirects"]}

    def final(path: str) -> str:
        seen = set()
        while path in hop and path not in seen:
            seen.add(path)
            path = hop[path]
        return path

    changed = 0
    for page in sorted((ROOT / "static").rglob("*.html")):
        html = original = page.read_text(encoding="utf-8")
        for src, _ in hop.items():
            if src in html:
                html = html.replace(f'href="{src}"', f'href="{final(src)}"')
                html = html.replace(f'href="{BASE}{src}"', f'href="{BASE}{final(src)}"')
        # 自分自身への 301 リンクは残らないよう、統合元ページ内も対象にする。
        if html != original:
            page.write_text(html, encoding="utf-8")
            changed += 1
    print(f"内部リンクを張り替え: {changed}ファイル")


def main() -> None:
    args = sys.argv[1:]
    if args == ["--fix-links"]:
        fix_links()
        return
    if len(args) < 2:
        raise SystemExit(__doc__)
    print(f"統合: {args[0]} ← {', '.join(args[1:])}")
    merge(args[0], args[1:])


if __name__ == "__main__":
    main()

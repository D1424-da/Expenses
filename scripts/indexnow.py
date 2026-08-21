#!/usr/bin/env python3
"""IndexNow で URL の更新を検索エンジンに通知する。

Bing・Yandex・Naver などが対応する規格で、1回の API 呼び出しで最大10,000件を
まとめて送れる。**Google は IndexNow に対応していない**ので、Google の
インデックスには一切影響しない。効くのは Bing 経由の流入と、Bing を検索基盤に
している ChatGPT / Copilot への反映速度。

所有権の証明は「鍵と同じ名前・同じ中身のテキストファイルをサイトルートに置く」
方式。static/<KEY>.txt がそれで、**公開されることが前提**の値なので秘密ではない
（鍵を知られても、そのドメインの URL を送信できるだけ）。

使い方:
    python3 scripts/indexnow.py --changed   # 前回コミットから lastmod が変わったURL
    python3 scripts/indexnow.py --all       # sitemap.xml の全URL
    python3 scripts/indexnow.py URL...      # 個別指定
    python3 scripts/indexnow.py --changed --dry-run  # 送信せず対象だけ出す
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
SITEMAP = STATIC / "sitemap.xml"
HOST = "get-tohon.online"
BASE_URL = f"https://{HOST}"
ENDPOINT = "https://api.indexnow.org/indexnow"

# 1リクエストの上限は10,000件だが、記事数から見て分割は不要。
# 念のため上限を超えたら送らずに落とす（黙って切り捨てない）。
MAX_URLS = 10_000


def find_key() -> str:
    """static/ 直下の <32〜128文字の英数字>.txt を鍵とみなす。

    鍵ファイル名＝鍵そのもの。中身も同じ値である必要がある（IndexNow の仕様）。
    """
    candidates = [
        p for p in STATIC.glob("*.txt")
        if re.fullmatch(r"[a-zA-Z0-9-]{8,128}", p.stem) and p.stem != "robots"
    ]
    if not candidates:
        raise SystemExit(
            "IndexNow の鍵ファイルが static/ にありません。\n"
            "  python3 -c \"import secrets; print(secrets.token_hex(16))\"\n"
            "で生成し、その値を名前と中身に持つ .txt を static/ に置いてください。"
        )
    if len(candidates) > 1:
        raise SystemExit(f"鍵ファイルが複数あります: {[p.name for p in candidates]}")

    path = candidates[0]
    body = path.read_text(encoding="utf-8").strip()
    if body != path.stem:
        raise SystemExit(
            f"{path.name}: ファイル名と中身が一致しません（IndexNow の所有権確認に失敗します）"
        )
    return path.stem


def sitemap_entries() -> dict[str, str]:
    """sitemap.xml から {URL: lastmod} を読む。"""
    xml = SITEMAP.read_text(encoding="utf-8")
    pairs = re.findall(r"<loc>([^<]+)</loc>\s*<lastmod>([^<]+)</lastmod>", xml)
    return dict(pairs)


def changed_urls() -> list[str]:
    """前回コミットの sitemap.xml と比べて、追加・lastmod 更新のあった URL。

    毎回の全件送信は避ける。変わっていない URL まで送ると、
    「更新した」という通知の意味が薄れる。
    """
    try:
        prev = subprocess.run(
            ["git", "show", "HEAD~1:static/sitemap.xml"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout
    except subprocess.CalledProcessError:
        # 初回や履歴が浅い場合は比較できない。全件にフォールバックせず、
        # 意図しない大量送信を避けるため空で返す。
        print("前回の sitemap.xml を取得できませんでした（--all を明示してください）")
        return []

    old = dict(re.findall(r"<loc>([^<]+)</loc>\s*<lastmod>([^<]+)</lastmod>", prev))
    now = sitemap_entries()
    return [u for u, mod in now.items() if old.get(u) != mod]


def submit(urls: list[str], key: str, dry_run: bool = False) -> int:
    if not urls:
        print("送信対象がありません。")
        return 0
    if len(urls) > MAX_URLS:
        raise SystemExit(f"URL が多すぎます（{len(urls)} > {MAX_URLS}）。分割してください。")

    off_host = [u for u in urls if not u.startswith(BASE_URL)]
    if off_host:
        # 他ドメインの URL を混ぜると 422 でリクエストごと拒否される。
        raise SystemExit(f"このホスト以外の URL が混ざっています: {off_host[:3]}")

    print(f"{len(urls)}件を IndexNow に送信します（Bing / Yandex / Naver。Googleは対象外）")
    for u in urls[:10]:
        print(f"  {u}")
    if len(urls) > 10:
        print(f"  … 他 {len(urls) - 10}件")

    if dry_run:
        print("--dry-run のため送信しませんでした。")
        return 0

    payload = json.dumps({
        "host": HOST,
        "key": key,
        "keyLocation": f"{BASE_URL}/{key}.txt",
        "urlList": urls,
    }).encode("utf-8")

    req = urllib.request.Request(
        ENDPOINT, data=payload,
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            print(f"送信しました: HTTP {res.status}")
            return 0
    except urllib.error.HTTPError as exc:
        # 200/202 以外は理由を出す。403=鍵が確認できない、422=URLとhostの不一致 など。
        print(f"送信に失敗: HTTP {exc.code} {exc.read()[:200].decode('utf-8', 'replace')}")
        return 1
    except urllib.error.URLError as exc:
        print(f"送信に失敗（接続エラー）: {exc.reason}")
        return 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("urls", nargs="*", help="送信する URL（省略時は --changed / --all を使う）")
    ap.add_argument("--all", action="store_true", help="sitemap.xml の全URLを送る")
    ap.add_argument("--changed", action="store_true", help="前回コミットから変わったURLだけ送る")
    ap.add_argument("--dry-run", action="store_true", help="送信せず対象だけ表示する")
    args = ap.parse_args()

    key = find_key()

    if args.all:
        urls = list(sitemap_entries())
    elif args.changed:
        urls = changed_urls()
    elif args.urls:
        urls = args.urls
    else:
        ap.error("--all / --changed / URL のいずれかを指定してください")

    return submit(urls, key, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())

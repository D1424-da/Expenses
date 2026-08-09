#!/usr/bin/env python3
"""
全ブログ記事に以下を一括適用する:
1. TOCのhref属性から対応アンカーIDを収集
2. <h2> タグにIDを付与（section id があればそのまま移植、なければTOCの順番で割り当て）
3. 読了時間を計算してメタ情報に追加
4. サイトマップのlastmodをファイルのmtimeで更新
"""
import re
import os
import json
import math
from pathlib import Path
from datetime import datetime, timezone

BLOG_DIR = Path("/home/user/Expenses/static/blog")
STATIC = Path("/home/user/Expenses/static")
BASE_URL = "https://get-tohon.online"

def reading_time(html_text):
    """HTML除去後の文字数から読了時間（分）を計算（500文字/分）"""
    text = re.sub(r'<[^>]+>', '', html_text)
    chars = len(text.replace(' ', '').replace('\n', ''))
    minutes = max(1, math.ceil(chars / 500))
    return minutes

def add_h2_ids(content):
    """
    TOCのhref一覧を取得し、対応する<h2>にIDを付与する。
    <section id="xxx"><h2> の場合はIDをh2に移植してsection idを削除。
    section idがない場合はTOCのhref順にh2へIDを割り当てる。
    """
    # TOCアンカー一覧（順序保持）
    toc_anchors = re.findall(r'<a href="(#[^"]+)"', content)
    toc_ids = [a[1:] for a in toc_anchors]  # '#' を除去

    if not toc_ids:
        return content, False

    modified = False

    # パターン1: <section id="xxx">...<h2>text</h2> → <h2 id="xxx">text</h2>
    def replace_section_h2(m):
        nonlocal modified
        sec_id = m.group(1)
        h2_content = m.group(2)
        modified = True
        return f'<section>\n<h2 id="{sec_id}">{h2_content}</h2>'

    content = re.sub(
        r'<section id="([^"]+)">\s*<h2>([^<]+)</h2>',
        replace_section_h2,
        content
    )

    # パターン2: IDなしのh2にTOCの順番でIDを割り当て
    h2_no_id_count = len(re.findall(r'<h2>(?!.*id=)', content))
    if h2_no_id_count > 0:
        assigned = [0]  # mutable counter for closure

        def assign_id(m):
            nonlocal modified
            idx = assigned[0]
            if idx < len(toc_ids):
                new_id = toc_ids[idx]
                assigned[0] += 1
                modified = True
                return f'<h2 id="{new_id}">'
            return m.group(0)

        content = re.sub(r'<h2>', assign_id, content)

    return content, modified

def add_reading_time(content, minutes):
    """
    読了時間を記事の日付行の近くに追加。
    既に存在する場合はスキップ。
    """
    if 'reading-time' in content or '読了' in content:
        return content, False

    # 日付を含む各種パターンの後に追加（複数のパターンを順番に試す）
    patterns = [
        r'(<div class="am(?:-meta)?">(?:<span>[^<]+</span>)+</div>)',  # am/am-meta div
        r'(<p class="am-lead">[^<]+</p>)',   # am-lead 段落の後
        r'(<h1[^>]*>[^<]+</h1>)',            # h1の後（最終手段）
    ]
    new_content, n = content, 0
    for date_pattern in patterns:
        replacement = r'\1\n<div class="am-reading-time">📖 約' + str(minutes) + r'分で読めます</div>'
        new_content, n = re.subn(date_pattern, replacement, content, count=1)
        if n:
            break
    return new_content, n > 0

def process_articles():
    files = sorted(BLOG_DIR.glob("*.html"))
    total = len(files)
    modified_count = 0
    skipped = 0

    for html_file in files:
        content = html_file.read_text(encoding="utf-8")
        original = content
        changed = False

        # 1. h2 ID付与
        content, h2_changed = add_h2_ids(content)
        if h2_changed:
            changed = True

        # 2. 読了時間追加
        mins = reading_time(content)
        content, rt_changed = add_reading_time(content, mins)
        if rt_changed:
            changed = True

        if changed:
            html_file.write_text(content, encoding="utf-8")
            modified_count += 1
        else:
            skipped += 1

    print(f"処理完了: {total}記事中 {modified_count}件更新, {skipped}件スキップ")
    return modified_count

def update_sitemap_lastmod():
    """サイトマップのlastmodをファイルのmtimeで更新"""
    sitemap_path = STATIC / "sitemap.xml"
    content = sitemap_path.read_text(encoding="utf-8")

    def replace_lastmod(m):
        url_path = m.group(1)  # e.g. /blog/ai-cooking.html
        # ファイルパスを解決
        rel = url_path.lstrip("/")
        file_path = STATIC / rel
        if file_path.exists():
            mtime = datetime.fromtimestamp(file_path.stat().st_mtime, tz=timezone.utc)
            return f'<lastmod>{mtime.strftime("%Y-%m-%d")}</lastmod>'
        return m.group(0)

    # <loc>https://get-tohon.online/blog/...</loc>\n    <lastmod>YYYY-MM-DD</lastmod>
    pattern = r'<loc>' + re.escape(BASE_URL) + r'(/blog/[^<]+)</loc>\s*\n\s*(<lastmod>[^<]+</lastmod>)'

    def replacer(m):
        url_path = m.group(1)
        rel = url_path.lstrip("/")
        file_path = STATIC / rel
        if file_path.exists():
            mtime = datetime.fromtimestamp(file_path.stat().st_mtime, tz=timezone.utc)
            date_str = mtime.strftime("%Y-%m-%d")
            return f'<loc>{BASE_URL}{url_path}</loc>\n    <lastmod>{date_str}</lastmod>'
        return m.group(0)

    new_content = re.sub(
        r'<loc>' + re.escape(BASE_URL) + r'(/blog/[^<]+\.html)</loc>\s*\n\s*<lastmod>[^<]+</lastmod>',
        replacer,
        content
    )

    if new_content != content:
        sitemap_path.write_text(new_content, encoding="utf-8")
        print("サイトマップのlastmodをmtimeで更新しました")
    else:
        print("サイトマップに変更なし")

if __name__ == "__main__":
    print("=== h2 ID付与 + 読了時間追加 ===")
    process_articles()
    print("\n=== サイトマップ lastmod 更新 ===")
    update_sitemap_lastmod()
    print("\n完了")

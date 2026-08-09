#!/usr/bin/env python3
"""
Note投稿済みファイルを posted/ フォルダに移動する。
使い方: python3 note_mark_posted.py <ファイル名またはslug>
例:    python3 note_mark_posted.py 60dai-fuufu-shokuhi
       python3 note_mark_posted.py 60dai-fuufu-shokuhi.txt
"""
import sys
import shutil
from pathlib import Path

NOTE_DIR = Path(__file__).parent / "note_posts"
POSTED_DIR = NOTE_DIR / "posted"
POSTED_DIR.mkdir(exist_ok=True)

def mark_posted(slug):
    slug = slug.removesuffix(".txt")
    src = NOTE_DIR / f"{slug}.txt"
    if not src.exists():
        print(f"❌ 見つかりません: {src}")
        return False
    dst = POSTED_DIR / f"{slug}.txt"
    shutil.move(src, dst)
    remaining = len(list(NOTE_DIR.glob("*.txt")))
    print(f"✅ 投稿済みに移動: {slug}.txt")
    print(f"   残り: {remaining}件 / 投稿済み: {len(list(POSTED_DIR.glob('*.txt')))}件")
    return True

if len(sys.argv) < 2:
    # 引数なしで実行した場合は状況を表示
    remaining = list(NOTE_DIR.glob("*.txt"))
    posted = list(POSTED_DIR.glob("*.txt"))
    print(f"📋 Note投稿状況")
    print(f"   未投稿: {len(remaining)}件")
    print(f"   投稿済み: {len(posted)}件")
    if remaining:
        print(f"\n次の投稿候補:")
        for f in sorted(remaining)[:5]:
            print(f"   {f.stem}")
else:
    for slug in sys.argv[1:]:
        mark_posted(slug)

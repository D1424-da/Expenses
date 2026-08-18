"""note 投稿用テキストの検証。

実際に起きていた問題:
  1. generate_note_posts.py の CATEGORY_TAGS / target_map のキーが
     articles.json の category と一致しておらず、135本中97本が既定値に
     落ちていた。結果、129本が #節約 と #家計管理 だけという状態だった。
  2. 統合（noindex 化）した記事の下書きが残り続けていた。
     その URL は 301 で別記事へ飛ぶため、投稿すると読者が意図しない
     ページに着地する。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NOTE_DIR = ROOT / "note_posts"
ARTICLES = ROOT / "static" / "blog" / "articles.json"

MAX_TAGS = 10  # note の上限
MIN_TAGS = 5   # これを下回ると露出の機会を捨てている


def _articles() -> list[dict]:
    return json.loads(ARTICLES.read_text(encoding="utf-8"))


def _drafts() -> list[Path]:
    return sorted(NOTE_DIR.glob("*.txt"))


def _tags(path: Path) -> list[str]:
    lines = [ln.strip() for ln in path.read_text(encoding="utf-8").splitlines()]
    tag_lines = [ln for ln in lines if ln.startswith("#")]
    if not tag_lines:
        return []
    return re.findall(r"#(\S+)", tag_lines[-1])


def test_drafts_exist():
    assert len(_drafts()) > 50


def test_generator_category_keys_match_articles_json():
    """生成スクリプトのカテゴリキーが articles.json と一致している。

    ここがずれると既定値に落ちるだけでエラーにならず、
    「全記事が同じタグ」という状態に静かになる。
    """
    import ast

    src = (ROOT / "generate_note_posts.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    found: dict[str, set[str]] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            name = getattr(target, "id", None)
            if name in ("CATEGORY_TAGS", "target_map") and isinstance(node.value, ast.Dict):
                found[name] = {
                    k.value for k in node.value.keys if isinstance(k, ast.Constant)
                }

    assert "CATEGORY_TAGS" in found, "CATEGORY_TAGS が見つからない"

    # 記事が1本も無いカテゴリ（build_blog.py に定義だけある "ライフスタイル" 等）は
    # キーとして持っていてよい。判定の基準はサイトのカテゴリ定義側に置く。
    build_src = (ROOT / "build_blog.py").read_text(encoding="utf-8")
    slugs_node = next(
        node.value
        for node in ast.walk(ast.parse(build_src))
        if isinstance(node, ast.Assign)
        and any(getattr(t, "id", None) == "CATEGORY_SLUGS" for t in node.targets)
    )
    defined = {k.value for k in slugs_node.keys if isinstance(k, ast.Constant)}

    used = {a["category"] for a in _articles()}
    for name, keys in found.items():
        unknown = keys - defined
        assert not unknown, (
            f"{name} にサイトのカテゴリ定義に無いキー: {sorted(unknown)}"
            "（既定値へ落ちて全記事が同じ内容になる）"
        )
        missing = used - keys - {"その他"}
        assert not missing, f"{name} に未対応のカテゴリ: {sorted(missing)}"


@pytest.mark.parametrize("path", _drafts(), ids=lambda p: p.stem)
def test_tag_count_is_reasonable(path: Path):
    """タグ数が note の上限内で、少なすぎない。"""
    tags = _tags(path)
    assert tags, f"{path.name} にハッシュタグが無い"
    assert len(tags) <= MAX_TAGS, f"{path.name}: {len(tags)}個は note の上限超過"
    assert len(tags) >= MIN_TAGS, f"{path.name}: {len(tags)}個は少なすぎる"
    assert len(set(tags)) == len(tags), f"{path.name}: タグが重複している"


def test_no_brand_tag():
    """ブランド名のタグを使わない。

    認知ゼロのタグを検索する人はおらず、上限10個の枠を1つ捨てることになる。
    """
    offenders = [p.name for p in _drafts() if "カケイシピ" in _tags(p)]
    assert not offenders, f"#カケイシピ が残っている: {offenders[:5]}"


def test_tags_are_not_all_identical():
    """全記事が同じタグの組み合わせになっていない。"""
    combos = {tuple(sorted(_tags(p))) for p in _drafts()}
    assert len(combos) > 20, f"タグの組み合わせが {len(combos)} 通りしかない"


def test_no_draft_for_consolidated_articles():
    """統合（noindex）した記事の下書きが残っていない。

    その URL は 301 で別記事へ飛ぶため、投稿すると読者が意図しない
    ページに着地する。
    """
    noindex = {a["slug"] for a in _articles() if a.get("noindex")}
    offenders = [p.stem for p in _drafts() if p.stem in noindex]
    assert not offenders, f"統合済み記事の下書きが残っている: {offenders}"


def test_links_point_to_live_articles():
    """本文中のリンク先が、実在して 301 されない記事である。"""
    import json as _json

    cfg = _json.loads((ROOT / "firebase.json").read_text(encoding="utf-8"))
    redirected = {r["source"] for r in cfg["hosting"]["redirects"]}
    live = {a["url"] for a in _articles() if not a.get("noindex")}

    problems = []
    for p in _drafts():
        for url in re.findall(r"https://get-tohon\.online(/blog/[^\s]+)", p.read_text(encoding="utf-8")):
            if url in redirected:
                problems.append(f"{p.name}: {url} は301される")
            elif url not in live:
                problems.append(f"{p.name}: {url} は公開記事に無い")
    assert not problems, "リンク先の問題: " + "; ".join(problems[:10])


# ---------------------------------------------------------------------------
# 投稿済み（posted/）の追随
# ---------------------------------------------------------------------------
#
# posted/ は「note に投稿し終えた下書き」の記録で、再生成時に上書きしない。
# そのぶん記事を統合しても中身が更新されないため、統合前に投稿したものは
# 古い URL を指したまま残る。実際、投稿済み7本のうち5本がこの状態だった
# （60dai-fuufu-shokuhi / ai-cooking / ai-recipe-weekly-plan /
#   beginner-3min-kakeibo / bento-recipe）。
#
# 301 で評価は引き継がれるので SEO 上の損失はほぼ無いが、note 本文で
# 予告した記事名と着地先の見出しが食い違う。統合したら note 側の URL も
# 直す必要がある、と気づけるようにする。

POSTED_DIR = NOTE_DIR / "posted"


def _redirect_map() -> dict[str, str]:
    cfg = json.loads((ROOT / "firebase.json").read_text(encoding="utf-8"))
    return {r["source"]: r["destination"] for r in cfg["hosting"]["redirects"]}


def _article_links(path: Path) -> list[str]:
    """本文中の記事URLをパスで返す（/login.html などの導線は除く）。"""
    text = path.read_text(encoding="utf-8")
    out = []
    for url in re.findall(r"https://get-tohon\.online(/[^\s　\"')）]*)", text):
        if url.startswith("/blog/"):
            out.append(url)
    return out


@pytest.mark.skipif(not POSTED_DIR.exists(), reason="posted/ が無い")
def test_posted_drafts_do_not_link_to_redirected_urls():
    """投稿済みの下書きが 301 される URL を指していない。

    落ちたときの直し方は2段階:
      1. note 側で該当記事の URL とタイトル表記を最終地点に差し替える
      2. posted/ のテキストも同じ内容に直す（記録を実態に合わせる）
    """
    redirects = _redirect_map()
    problems = []
    for path in sorted(POSTED_DIR.glob("*.txt")):
        for link in _article_links(path):
            if link in redirects:
                problems.append(f"{path.name}: {link} → {redirects[link]}")
    assert not problems, (
        "投稿済み note が 301 される URL を指している（note 側の修正が必要）: "
        + "; ".join(problems)
    )


@pytest.mark.skipif(not POSTED_DIR.exists(), reason="posted/ が無い")
def test_posted_and_pending_do_not_overlap():
    """投稿済みと未投稿で同じ記事を二重に持たない（重複投稿の元になる）。"""
    posted = {p.stem for p in POSTED_DIR.glob("*.txt")}
    pending = {p.stem for p in _drafts()}
    overlap = sorted(posted & pending)
    assert not overlap, f"posted/ と未投稿の両方にある: {overlap}"

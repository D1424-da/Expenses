#!/usr/bin/env python3
"""
旧テンプレート (class="hd" + インラインstyle + 2カラム) →
新テンプレート (class="bh" + blog-article.css + 1カラム) 変換スクリプト
"""

from bs4 import BeautifulSoup
import os
import sys

BLOG_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static", "blog")

# コンテンツ内クラス名リネームマップ
CLASS_RENAMES = [
    ('class="ld"',       'class="am-lead"'),
    ('class="tb"',       'class="highlight-box"'),
    ('class="cb"',       'class="cta-box"'),
    ('class="bc2"',      'class="cta-btn"'),
    ('class="sg"',       'class="card-grid"'),
    ('class="sc"',       'class="stat-card"'),
    ('class="sn"',       'class="stat-num"'),
    ('class="su"',       'class="stat-unit"'),
    ('class="cg"',       'class="card-grid"'),
    ('class="cc"',       'class="card"'),
    ('class="ci"',       'class="card-icon"'),
    ('class="ct"',       'class="card-title"'),
    ('class="cd"',       'class="card-desc"'),
    ('class="flow-step"','class="step-title"'),
]


def extract_hero_info(hero_section):
    """ヒーロー(.ah)からカテゴリ・h1・日付を取得"""
    category = 'ブログ'
    h1_html = ''
    date_text = ''

    if not hero_section:
        return category, h1_html, date_text

    ai_div = hero_section.find('div', class_='ai')
    if not ai_div:
        return category, h1_html, date_text

    ac = ai_div.find(class_='ac')
    if ac:
        category = ac.get_text(strip=True)

    h1 = ai_div.find('h1')
    if h1:
        # <br>タグは <br> のまま保持
        h1_html = h1.decode_contents()

    am_div = ai_div.find('div', class_='am')
    if am_div:
        spans = am_div.find_all('span')
        if spans:
            date_text = spans[0].get_text(strip=True)

    return category, h1_html, date_text


def build_toc(sidebar):
    """サイドバーの<ul class="toc">→<nav class="am-toc">変換"""
    if not sidebar:
        return ''
    toc_ul = sidebar.find('ul', class_='toc')
    if not toc_ul:
        return ''
    items = toc_ul.find_all('li', recursive=False)
    if not items:
        return ''
    items_html = '\n        '.join(
        f'<li>{li.decode_contents()}</li>' for li in items
    )
    return (
        '<nav class="am-toc">\n'
        '      <div class="am-toc-title">目次</div>\n'
        '      <ol>\n'
        f'        {items_html}\n'
        '      </ol>\n'
        '    </nav>'
    )


def apply_class_renames(html_str):
    for old, new in CLASS_RENAMES:
        html_str = html_str.replace(old, new)
    return html_str


def convert_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    soup = BeautifulSoup(content, 'html.parser')

    # 旧テンプレートチェック
    if not soup.find('header', class_='hd'):
        return False, 'not old template'

    # 1. <style>ブロック削除
    for style_tag in soup.find_all('style'):
        style_tag.decompose()

    # HEAD取得（styleタグ除去済み）
    head = soup.find('head')
    head_html = str(head)

    # 2. ヒーロー情報抽出（<section class="ah"> または <div class="ah">）
    hero = soup.find('section', class_='ah') or soup.find('div', class_='ah')
    category, h1_html, date_text = extract_hero_info(hero)

    if not h1_html:
        return False, 'h1 not found'

    # 3. article(.ab)取得
    article_ab = soup.find('article', class_='ab')
    if not article_ab:
        return False, '.ab article not found'

    # 4. サイドバーTOC取得
    sidebar = soup.find('aside', class_='sb') or soup.find('aside')
    toc_html = build_toc(sidebar)

    # 5. リード段落(.ld)取得 → am-leadに変換
    lead_tag = article_ab.find(class_='ld')
    lead_html = ''
    if lead_tag:
        lead_tag['class'] = ['am-lead']
        lead_html = str(lead_tag)
        lead_tag.decompose()

    # 6. 残りのarticle本文
    article_body = apply_class_renames(article_ab.decode_contents())

    # 7. 後続要素を取得
    related  = soup.find('section', class_='related-articles')
    prevnext = soup.find('nav', class_='prevnext')
    footer   = soup.find('footer', class_='ft') or soup.find('footer')

    related_html  = str(related)  if related  else ''
    prevnext_html = str(prevnext) if prevnext else ''
    footer_inner  = footer.decode_contents() if footer else ''

    # 8. 新テンプレートHTML組み立て
    new_html = f"""<!DOCTYPE html>
<html lang="ja">
{head_html}
<body>
<header class="bh">
  <a class="bh-logo" href="/">カケイシピ</a>
  <nav class="bh-nav">
    <a href="/blog.html">ブログ一覧</a>
    <a href="/login.html" class="bh-cta">無料で試す</a>
  </nav>
</header>
<main class="am-wrap">
  <article class="am">
    <div class="am-eyebrow"><a href="/blog.html" class="am-cat">{category}</a></div>
    <h1 class="am-title">{h1_html}</h1>
    <div class="am"><span>{date_text}</span></div>
    {lead_html}
    {toc_html}
    {article_body}
  </article>
</main>
{related_html}
{prevnext_html}
<footer class="bf">{footer_inner}</footer>
</body>
</html>"""

    with open(filepath, 'w', encoding='utf-8', newline='\n') as f:
        f.write(new_html)

    return True, 'ok'


def main(test_file=None):
    if test_file:
        # 1ファイルテスト
        fp = os.path.join(BLOG_DIR, test_file)
        ok, msg = convert_file(fp)
        print(f"{'OK' if ok else 'NG'}: {test_file} — {msg}")
        return

    # 全件処理
    files = [f for f in os.listdir(BLOG_DIR) if f.endswith('.html')]
    ok_count = 0
    skip_count = 0
    for fname in sorted(files):
        fp = os.path.join(BLOG_DIR, fname)
        ok, msg = convert_file(fp)
        if ok:
            print(f"  OK: {fname}")
            ok_count += 1
        else:
            print(f"  --: {fname} ({msg})")
            skip_count += 1
    print(f"\n完了: {ok_count}件変換 / {skip_count}件スキップ")


if __name__ == '__main__':
    test = sys.argv[1] if len(sys.argv) > 1 else None
    main(test)

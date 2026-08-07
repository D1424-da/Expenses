#!/usr/bin/env python3
"""header/article-hero テンプレートを bh/am テンプレートへ変換する。"""

from bs4 import BeautifulSoup
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
BLOG = ROOT / "static" / "blog"

TARGETS = [
    "ai-recipe-weekly-plan.html",
    "food-cost-cut-20000.html",
    "receipt-kakeibo-basics.html",
]

REPL = [
    ('class="btn-cta"', 'class="cta-btn"'),
    ('class="lead"', 'class="am-lead"'),
    ('class="stat-row"', 'class="card-grid stat-grid"'),
    ('class="step-list"', 'class="step-flow"'),
    ('class="how-to-steps"', 'class="step-flow"'),
    ('class="how-to-step"', 'class="step-item"'),
    ('class="step-circle"', 'class="step-num-badge"'),
    ('class="voice-card"', 'class="voice"'),
    ('class="voice-author"', 'class="voice-attr"'),
]


def apply_repl(s: str) -> str:
    for old, new in REPL:
        s = s.replace(old, new)
    return s


def convert_file(path: pathlib.Path):
    src = path.read_text(encoding="utf-8")
    soup = BeautifulSoup(src, "html.parser")

    if not soup.find(class_="header") or not soup.find(class_="article-hero"):
        return False, "not header template"

    for st in soup.find_all("style"):
        st.decompose()

    head = soup.find("head")
    hero = soup.find(class_="article-hero")
    article_body = soup.find(class_="article-body")
    sidebar = soup.find(class_="sidebar")

    if not head or not hero or not article_body:
        return False, "required block missing"

    cat = hero.find(class_="article-category")
    h1 = hero.find("h1")
    meta = hero.find(class_="article-meta-hero")

    category = cat.get_text(strip=True) if cat else "ブログ"
    h1_html = h1.decode_contents() if h1 else ""
    date_text = ""
    if meta:
        spans = meta.find_all("span")
        if spans:
            date_text = spans[0].get_text(" ", strip=True).replace("📅", "").strip()

    lead = article_body.find(class_="lead")
    lead_html = ""
    if lead:
        lead["class"] = ["am-lead"]
        lead_html = str(lead)
        lead.decompose()

    toc_html = ""
    if sidebar:
        toc = sidebar.find("ul", class_="toc-list") or sidebar.find("ul", class_="toc")
        if toc:
            lis = toc.find_all("li", recursive=False)
            if lis:
                items = "\n        ".join(f"<li>{li.decode_contents()}</li>" for li in lis)
                toc_html = (
                    '<nav class="am-toc">\n'
                    '      <div class="am-toc-title">目次</div>\n'
                    '      <ol>\n'
                    f'        {items}\n'
                    '      </ol>\n'
                    '    </nav>'
                )

    body_html = apply_repl(article_body.decode_contents())

    related = soup.find("section", class_="related-articles")
    prevnext = soup.find("nav", class_="prevnext")
    footer = soup.find("footer", class_="footer") or soup.find("footer", class_="ft") or soup.find("footer")

    related_html = str(related) if related else ""
    prevnext_html = str(prevnext) if prevnext else ""
    footer_inner = footer.decode_contents() if footer else ""

    out = f"""<!DOCTYPE html>
<html lang=\"ja\">
{str(head)}
<body>
<header class=\"bh\">
  <a class=\"bh-logo\" href=\"/\">カケイシピ</a>
  <nav class=\"bh-nav\">
    <a href=\"/blog.html\">ブログ一覧</a>
    <a href=\"/login.html\" class=\"bh-cta\">無料で試す</a>
  </nav>
</header>
<main class=\"am-wrap\">
  <article class=\"am\">
    <div class=\"am-eyebrow\"><a href=\"/blog.html\" class=\"am-cat\">{category}</a></div>
    <h1 class=\"am-title\">{h1_html}</h1>
    <div class=\"am\"><span>{date_text}</span></div>
    {lead_html}
    {toc_html}
    {body_html}
  </article>
</main>
{related_html}
{prevnext_html}
<footer class=\"bf\">{footer_inner}</footer>
</body>
</html>
"""

    path.write_text(out, encoding="utf-8", newline="\n")
    return True, "ok"


def main():
    for name in TARGETS:
        p = BLOG / name
        ok, msg = convert_file(p)
        print(("OK" if ok else "NG") + f": {name} ({msg})")


if __name__ == "__main__":
    main()

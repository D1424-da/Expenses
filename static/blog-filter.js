// ブログ一覧のカテゴリタブ絞り込み（CSPのためインラインscriptから分離）。
const _catItems = [
  ...document.querySelectorAll(".featured[data-cat], .card[data-cat], .mini-card[data-cat]"),
];
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const cat = btn.dataset.cat;
    let visibleCount = 0;
    _catItems.forEach(el => {
      const show = cat === "すべて" || el.dataset.cat === cat;
      el.style.display = show ? "" : "none";
      if (show) visibleCount++;
    });
    document.getElementById("category-empty-hint").hidden = visibleCount > 0;
    // ハッシュに現在のカテゴリを反映（共有・戻る操作に対応）
    history.replaceState(null, "", cat === "すべて" ? location.pathname : `${location.pathname}#cat=${encodeURIComponent(cat)}`);
  });
});
// ページ読み込み時にハッシュのカテゴリを復元
const _hashMatch = location.hash.match(/^#cat=(.+)$/);
if (_hashMatch) {
  const initialCat = decodeURIComponent(_hashMatch[1]);
  const btn = [...document.querySelectorAll(".tab")].find(b => b.dataset.cat === initialCat);
  if (btn) btn.click();
}

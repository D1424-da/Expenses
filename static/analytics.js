// localhost / CI 環境では GA4 を完全に無効化する
const _gaDisabled =
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1" ||
  location.hostname.endsWith(".local") ||
  // ?ga_opt_out=1 を一度踏むと localStorage に永続保存されて以後すべての計測を除外
  (function () {
    if (new URLSearchParams(location.search).get("ga_opt_out") === "1") {
      localStorage.setItem("ga_opt_out", "1");
    }
    return localStorage.getItem("ga_opt_out") === "1";
  })();

window.dataLayer = window.dataLayer || [];
function gtag() { if (!_gaDisabled) dataLayer.push(arguments); }

if (!_gaDisabled) {
  gtag("js", new Date());
  gtag("config", "G-YTNPDRH19H");
}

window.trackEvent = function (name, params) {
  if (!_gaDisabled && typeof gtag === "function") gtag("event", name, params || {});
};

window.trackPageview = function (path, title) {
  if (_gaDisabled || typeof gtag !== "function") return;
  gtag("event", "page_view", {
    page_path: path,
    page_title: title || path,
    page_location: location.origin + path,
  });
};

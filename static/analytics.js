window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag("js", new Date());
gtag("config", "G-YTNPDRH19H");

window.trackEvent = function (name, params) {
  if (typeof gtag === "function") gtag("event", name, params || {});
};

// SPA内の画面遷移をCMSサイトのページ遷移と同様にGA4へ計測する。
// page_path は実際のURLを書き換えないため、GA4上の仮想URLとして送る。
window.trackPageview = function (path, title) {
  if (typeof gtag !== "function") return;
  gtag("event", "page_view", {
    page_path: path,
    page_title: title || path,
    page_location: location.origin + path,
  });
};

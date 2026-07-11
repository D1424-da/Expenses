window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag("js", new Date());
gtag("config", "G-YTNPDRH19H");

window.trackEvent = function (name, params) {
  if (typeof gtag === "function") gtag("event", name, params || {});
};

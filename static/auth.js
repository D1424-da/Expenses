// 認証ロジック: Google / メール・パスワード / インアプリブラウザ対応。
import {
  GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged, getAdditionalUserInfo,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import { auth, provider } from "./firebase-init.js";
import { state } from "./app-state.js";
import { $, closeModal } from "./dom-utils.js";
import { log, logErr } from "./log.js";

// LINE / Instagram / Facebook などのインアプリブラウザを検知する。
// これらのWebViewではGoogleのOAuthが完全にブロックされるため、外部ブラウザへ誘導する。
const _ua           = navigator.userAgent;
const _isInAppBrowser = /Line\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(_ua);
const _isMobile     = /Android|iPhone|iPad|iPod/i.test(_ua);
// Safari は ITP でリダイレクト認証が失敗するため、ポップアップを使う。
// iOS Chrome は UA に "CriOS" を含み "chrome" は含まないため、明示的に除外する。
const _isSafari     = /Safari/i.test(_ua) && !/Chrome|CriOS|Android/i.test(_ua);

if (_isInAppBrowser) {
  log("インアプリブラウザを検知:", _ua);
  const warning = $("inapp-warning");
  if (warning) warning.hidden = false;
  const loginBtn = $("google-login");
  if (loginBtn) loginBtn.hidden = true;
}

$("copy-url-btn") && ($("copy-url-btn").onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    $("copy-url-btn").textContent = "✅ コピーしました";
    setTimeout(() => { $("copy-url-btn").textContent = "🔗 URLをコピー"; }, 2500);
  } catch {
    prompt("URLをコピーしてください:", location.href);
  }
});

getRedirectResult(auth).then((result) => {
  if (result?.user) {
    log("リダイレクトログイン成功:", result.user.email);
    if (getAdditionalUserInfo(result)?.isNewUser && typeof window.trackEvent === "function") {
      window.trackEvent("sign_up", { method: "google" });
    }
  }
}).catch((err) => {
  if (err.code === "auth/credential-already-in-use") return;
  logErr("getRedirectResult エラー:", err.code, err.message);
  if (_isSafari) return;
  const el = $("login-error");
  el.textContent = "ログインに失敗しました: " + (err.code || err.message);
  el.hidden = false;
});

let _googleLoginBusy = false;
$("google-login").onclick = async () => {
  if (_googleLoginBusy) return;
  _googleLoginBusy = true;
  const btn = $("google-login");
  btn.disabled = true;
  const useRedirect = _isMobile && !_isSafari;
  log("ログインボタン押下:", useRedirect ? "redirect" : "popup");
  $("login-error").hidden = true;
  try {
    if (useRedirect) {
      await signInWithRedirect(auth, provider);
    } else {
      const result = await signInWithPopup(auth, provider);
      log("ポップアップログイン成功:", result.user.email);
      if (getAdditionalUserInfo(result)?.isNewUser && typeof window.trackEvent === "function") {
        window.trackEvent("sign_up", { method: "google" });
      }
    }
  } catch (err) {
    if (err.code !== "auth/cancelled-popup-request" && err.code !== "auth/popup-closed-by-user") {
      logErr("ログインエラー:", err.code, err.message, err);
      const el = $("login-error");
      el.textContent = "ログインに失敗しました: " + (err.code || err.message);
      el.hidden = false;
    }
  } finally {
    _googleLoginBusy = false;
    btn.disabled = false;
  }
};

// ---- メール/パスワード認証 --------------------------------------------------
const _emailForm = $("email-login-form");
if (_emailForm) {
  const _modeToggle    = $("email-mode-toggle");
  const _emailInput    = $("email-input");
  const _passwordInput = $("password-input");
  const _emailError    = $("email-login-error");
  const _submitBtn     = $("email-submit-btn");
  const _resetBtn      = $("email-reset-btn");
  let _emailMode = "login"; // "login" | "signup"

  _modeToggle && (_modeToggle.onclick = () => {
    _emailMode = _emailMode === "login" ? "signup" : "login";
    _submitBtn.textContent = _emailMode === "signup" ? "新規登録" : "ログイン";
    _modeToggle.textContent = _emailMode === "signup"
      ? "すでにアカウントをお持ちの方はこちら"
      : "アカウントを新規作成";
    _emailError.hidden = true;
  });

  _emailForm.onsubmit = async (e) => {
    e.preventDefault();
    const email = _emailInput.value.trim();
    const pass  = _passwordInput.value;
    _emailError.hidden = true;
    _submitBtn.disabled = true;
    try {
      if (_emailMode === "signup") {
        await createUserWithEmailAndPassword(auth, email, pass);
        if (typeof window.trackEvent === "function") window.trackEvent("sign_up", { method: "email" });
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
      }
    } catch (err) {
      logErr("メールログインエラー:", err.code);
      const msgs = {
        "auth/user-not-found":        "メールアドレスが見つかりません。",
        "auth/wrong-password":        "パスワードが違います。",
        "auth/email-already-in-use":  "このメールアドレスはすでに登録されています。",
        "auth/weak-password":         "パスワードは6文字以上にしてください。",
        "auth/invalid-email":         "メールアドレスの形式が正しくありません。",
        "auth/invalid-credential":    "メールアドレスまたはパスワードが違います。",
      };
      _emailError.textContent = msgs[err.code] || "エラー: " + (err.code || err.message);
      _emailError.hidden = false;
    } finally {
      _submitBtn.disabled = false;
    }
  };

  _resetBtn && (_resetBtn.onclick = async () => {
    const email = _emailInput.value.trim();
    if (!email) { _emailError.textContent = "メールアドレスを入力してください。"; _emailError.hidden = false; return; }
    try {
      await sendPasswordResetEmail(auth, email);
      _emailError.textContent = "パスワードリセットメールを送信しました。";
      _emailError.style.color = "var(--c-ok, green)";
      _emailError.hidden = false;
    } catch (err) {
      _emailError.textContent = "送信に失敗しました: " + (err.code || err.message);
      _emailError.style.color = "";
      _emailError.hidden = false;
    }
  });
}

/**
 * 認証状態の変化を監視してコールバックを呼ぶ。
 * @param {Function} onLogin  - ログイン時: (user) => void
 * @param {Function} onLogout - ログアウト時: () => void
 */
export function watchAuthState(onLogin, onLogout) {
  onAuthStateChanged(auth, (user) => {
    log("認証状態の変化:", user ? `ログイン中 (${user.email})` : "未ログイン");
    state.currentUser = user;
    if (user) {
      $("login-screen").hidden = true;
      $("app").hidden = false;
      if (typeof window.trackPageview === "function") window.trackPageview("/app/home", "家計簿ホーム");
      onLogin(user);
    } else {
      onLogout();
      $("app").hidden = true;
      $("login-screen").hidden = false;
      if (typeof window.trackPageview === "function") window.trackPageview("/app/login", "ログイン");
    }
  });
}

export { auth, signOut, closeModal };

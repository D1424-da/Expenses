// 旧URL（web.app）を正式ドメイン（get-tohon.online）へリダイレクト。
// firebaseapp.com は Firebase Auth の認証ハンドラ専用ドメインのため対象外にする。
if (location.hostname === 'expenses-9af61.web.app') {
  location.replace('https://get-tohon.online' + location.pathname + location.search + location.hash);
}

// firebaseapp.com → web.app へリダイレクト（Google認証CSP衝突対策）
if (location.hostname === 'expenses-9af61.firebaseapp.com') {
  location.replace('https://expenses-9af61.web.app' + location.pathname + location.search + location.hash);
}

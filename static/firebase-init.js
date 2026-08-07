// Firebase アプリ・Auth・Firestore の初期化。
// 他のモジュールはここから auth/db/provider をインポートする。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";
import { log } from "./log.js";

export const fbApp = initializeApp(firebaseConfig);
export const auth  = getAuth(fbApp);
export const db    = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

export const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

log("Firebase初期化完了", {
  projectId: firebaseConfig.projectId,
  authDomain: firebaseConfig.authDomain,
  origin: location.origin,
  href: location.href,
});

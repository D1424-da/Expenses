// Firebase アプリ・Auth・Firestore の初期化。
// 他のモジュールはここから auth/db/provider をインポートする。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  connectFirestoreEmulator, memoryLocalCache,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";
import { log } from "./log.js";

const _useEmulator = typeof window !== "undefined" && window.__USE_EMULATOR__ === true;

export const fbApp = initializeApp(firebaseConfig);
export const auth  = getAuth(fbApp);
export const db    = initializeFirestore(fbApp, {
  localCache: _useEmulator
    ? memoryLocalCache()
    : persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

if (_useEmulator) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  log("Firebase Emulator に接続しました");
}

export const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

log("Firebase初期化完了", {
  projectId: firebaseConfig.projectId,
  authDomain: firebaseConfig.authDomain,
  origin: location.origin,
  href: location.href,
});

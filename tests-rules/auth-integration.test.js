/**
 * 認証統合テスト — Auth Emulator + Firestore Emulator
 *
 * 前提: Firebase Emulator が起動済みであること
 *   Auth:      http://127.0.0.1:9099
 *   Firestore: http://127.0.0.1:8080
 *
 * このテストは Firebase SDK (Node.js) と Emulator REST API を使って
 * 認証後のデータ読み書きフローを検証する。
 */
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "fs";
import {
  doc,
  getDoc,
  setDoc,
  collection,
  getDocs,
  query,
} from "firebase/firestore";

const PROJECT_ID    = "expenses-9af61";
const AUTH_EMULATOR = "http://127.0.0.1:9099";
const RULES_PATH    = "./firestore.rules";

let testEnv;

// ---------------------------------------------------------------------------
// Auth Emulator REST API ヘルパー
// ---------------------------------------------------------------------------

async function signUpUser(email, password) {
  const res = await fetch(
    `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  if (!res.ok) throw new Error(`signUp failed: ${await res.text()}`);
  return res.json(); // { idToken, localId, email, ... }
}

async function signInUser(email, password) {
  const res = await fetch(
    `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  if (!res.ok) throw new Error(`signIn failed: ${await res.text()}`);
  return res.json();
}

async function clearAllUsers() {
  await fetch(
    `${AUTH_EMULATOR}/emulator/v1/projects/${PROJECT_ID}/accounts`,
    { method: "DELETE" }
  );
}

// ---------------------------------------------------------------------------
// テスト環境セットアップ
// ---------------------------------------------------------------------------

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(RULES_PATH, "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv.clearFirestore();
  await clearAllUsers();
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await clearAllUsers();
});

// ---------------------------------------------------------------------------
// A: Auth Emulator — ユーザー作成・認証フロー
// ---------------------------------------------------------------------------

describe("Auth Emulator — ユーザー認証フロー", () => {
  test("新規ユーザーを作成して ID トークンを取得できる", async () => {
    const { idToken, localId, email } = await signUpUser("new@example.com", "pass123");
    expect(idToken).toBeTruthy();
    expect(localId).toBeTruthy();
    expect(email).toBe("new@example.com");
  });

  test("登録済みユーザーでサインインできる", async () => {
    await signUpUser("user@example.com", "pass123");
    const { idToken, localId } = await signInUser("user@example.com", "pass123");
    expect(idToken).toBeTruthy();
    expect(localId).toBeTruthy();
  });

  test("誤ったパスワードではサインインできない", async () => {
    await signUpUser("user@example.com", "pass123");
    await expect(signInUser("user@example.com", "wrongpass")).rejects.toThrow();
  });

  test("存在しないユーザーでサインインできない", async () => {
    await expect(signInUser("ghost@example.com", "pass123")).rejects.toThrow();
  });

  test("同じメールアドレスで二重登録はできない", async () => {
    await signUpUser("dup@example.com", "pass123");
    await expect(signUpUser("dup@example.com", "pass456")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// B: 認証後の Firestore アクセス — subscription なしのデフォルト状態
// ---------------------------------------------------------------------------

describe("認証後の Firestore アクセス — subscription なし", () => {
  test("認証ユーザーは自分の settings/budget を書き込める", async () => {
    const { localId } = await signUpUser("budget@example.com", "pass123");

    const db = testEnv.authenticatedContext(localId).firestore();
    await assertSucceeds(
      setDoc(doc(db, `users/${localId}/settings/budget`), { food: 30000, daily: 1000 })
    );
  });

  test("認証ユーザーは自分の settings/budget を読み込める", async () => {
    const { localId } = await signUpUser("budget@example.com", "pass123");

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `users/${localId}/settings/budget`), { food: 20000 });
    });

    const db = testEnv.authenticatedContext(localId).firestore();
    const snap = await assertSucceeds(getDoc(doc(db, `users/${localId}/settings/budget`)));
    expect(snap.data()).toEqual({ food: 20000 });
  });

  test("subscription なしでは expenses を作成できない", async () => {
    const { localId } = await signUpUser("free@example.com", "pass123");

    const db = testEnv.authenticatedContext(localId).firestore();
    await assertFails(
      setDoc(doc(db, `users/${localId}/expenses/exp1`), {
        amount: 1500,
        date: "2026-08-08",
        store: "スーパー",
        category: "食費",
      })
    );
  });

  test("他のユーザーのデータを読み書きできない", async () => {
    const { localId: uid1 } = await signUpUser("user1@example.com", "pass123");
    const { localId: uid2 } = await signUpUser("user2@example.com", "pass123");

    // uid2 が uid1 のデータを読もうとする
    const db2 = testEnv.authenticatedContext(uid2).firestore();
    await assertFails(getDoc(doc(db2, `users/${uid1}/settings/budget`)));

    // uid2 が uid1 の settings に書こうとする
    await assertFails(
      setDoc(doc(db2, `users/${uid1}/settings/budget`), { food: 5000 })
    );
  });
});

// ---------------------------------------------------------------------------
// C: 認証後の Firestore アクセス — subscription あり（プレミアムフロー）
// ---------------------------------------------------------------------------

describe("認証後の Firestore アクセス — アクティブ subscription", () => {
  const activeSub = {
    status: "active",
    plan: "trial",
    currentPeriodEnd: Math.floor(Date.now() / 1000) + 86400 * 30,
  };

  async function setSubscription(uid, subData) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `users/${uid}/settings/subscription`), subData);
    });
  }

  test("アクティブ subscription があれば expenses を作成できる", async () => {
    const { localId } = await signUpUser("premium@example.com", "pass123");
    await setSubscription(localId, activeSub);

    const db = testEnv.authenticatedContext(localId).firestore();
    await assertSucceeds(
      setDoc(doc(db, `users/${localId}/expenses/exp1`), {
        amount: 2000,
        date: "2026-08-08",
        store: "コンビニ",
        category: "食費",
      })
    );
  });

  test("expenses を作成後に読み取れる", async () => {
    const { localId } = await signUpUser("premium@example.com", "pass123");
    await setSubscription(localId, activeSub);

    const expenseData = {
      amount: 3500,
      date: "2026-08-08",
      store: "イオン",
      category: "日用品",
    };

    const db = testEnv.authenticatedContext(localId).firestore();
    await assertSucceeds(setDoc(doc(db, `users/${localId}/expenses/exp1`), expenseData));
    const snap = await assertSucceeds(getDoc(doc(db, `users/${localId}/expenses/exp1`)));
    expect(snap.data()).toEqual(expenseData);
  });

  test("複数の expenses を書き込んで参照できる", async () => {
    const { localId } = await signUpUser("premium@example.com", "pass123");
    await setSubscription(localId, activeSub);

    const db = testEnv.authenticatedContext(localId).firestore();
    const expenseItems = [
      { amount: 1000, date: "2026-08-01", store: "ローソン", category: "食費" },
      { amount: 2000, date: "2026-08-02", store: "セブン", category: "食費" },
      { amount: 5000, date: "2026-08-03", store: "ドラッグストア", category: "日用品" },
    ];

    for (let i = 0; i < expenseItems.length; i++) {
      await assertSucceeds(
        setDoc(doc(db, `users/${localId}/expenses/exp${i}`), expenseItems[i])
      );
    }

    const collectionSnap = await assertSucceeds(
      getDocs(query(collection(db, `users/${localId}/expenses`)))
    );
    expect(collectionSnap.size).toBe(3);
  });

  test("subscription は本人でも直接書き込めない（Admin のみ）", async () => {
    const { localId } = await signUpUser("premium@example.com", "pass123");

    const db = testEnv.authenticatedContext(localId).firestore();
    await assertFails(
      setDoc(doc(db, `users/${localId}/settings/subscription`), activeSub)
    );
  });

  test("mealPlans を作成・読み取り・削除できる", async () => {
    const { localId } = await signUpUser("meal@example.com", "pass123");

    const db = testEnv.authenticatedContext(localId).firestore();
    const mealData = { date: "2026-08-08", 夕食: "カレー" };

    await assertSucceeds(setDoc(doc(db, `users/${localId}/mealPlans/2026-08-08`), mealData));
    const snap = await assertSucceeds(getDoc(doc(db, `users/${localId}/mealPlans/2026-08-08`)));
    expect(snap.data()).toEqual(mealData);
  });

  test("savedRecipes を作成・読み取りできる", async () => {
    const { localId } = await signUpUser("recipe@example.com", "pass123");

    const db = testEnv.authenticatedContext(localId).firestore();
    const recipeData = {
      title: "チキンカレー",
      markdown: "## 材料\n- 鶏肉",
      items: ["鶏肉", "カレールー"],
      category: "カレー",
    };

    await assertSucceeds(setDoc(doc(db, `users/${localId}/savedRecipes/r1`), recipeData));
    const snap = await assertSucceeds(getDoc(doc(db, `users/${localId}/savedRecipes/r1`)));
    expect(snap.data()).toEqual(recipeData);
  });
});

// ---------------------------------------------------------------------------
// D: 複数ユーザー間のデータ分離
// ---------------------------------------------------------------------------

describe("複数ユーザー間のデータ分離", () => {
  const activeSub = {
    status: "active",
    plan: "trial",
    currentPeriodEnd: Math.floor(Date.now() / 1000) + 86400 * 30,
  };

  test("ユーザー A のデータはユーザー B から見えない", async () => {
    const { localId: uid1 } = await signUpUser("alice@example.com", "pass123");
    const { localId: uid2 } = await signUpUser("bob@example.com", "pass123");

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), `users/${uid1}/settings/subscription`), activeSub);
      await setDoc(doc(ctx.firestore(), `users/${uid1}/expenses/private`), {
        amount: 50000, date: "2026-08-08", store: "高級店", category: "娯楽",
      });
    });

    // uid2 は uid1 の expenses にアクセスできない
    const db2 = testEnv.authenticatedContext(uid2).firestore();
    await assertFails(getDoc(doc(db2, `users/${uid1}/expenses/private`)));
  });

  test("各ユーザーは独立した設定を持てる", async () => {
    const { localId: uid1 } = await signUpUser("alice@example.com", "pass123");
    const { localId: uid2 } = await signUpUser("bob@example.com", "pass123");

    const db1 = testEnv.authenticatedContext(uid1).firestore();
    const db2 = testEnv.authenticatedContext(uid2).firestore();

    await assertSucceeds(
      setDoc(doc(db1, `users/${uid1}/settings/budget`), { food: 30000 })
    );
    await assertSucceeds(
      setDoc(doc(db2, `users/${uid2}/settings/budget`), { food: 50000 })
    );

    const snap1 = await getDoc(doc(db1, `users/${uid1}/settings/budget`));
    const snap2 = await getDoc(doc(db2, `users/${uid2}/settings/budget`));

    expect(snap1.data().food).toBe(30000);
    expect(snap2.data().food).toBe(50000);
  });
});

/**
 * Firestore セキュリティルールテスト
 *
 * 検証項目:
 *   - 認証なしのアクセスは全拒否
 *   - 他ユーザーのデータにアクセス不可
 *   - expenses: プレミアム有効時のみ create/update 可
 *   - subscription: クライアントから書き込み不可
 *   - settings: budget/shoppingList は書き込み可、subscription は不可
 *   - mealPlans / savedRecipes: 認証済み本人のみ
 *   - バリデーション: 不正フィールドは拒否
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
  updateDoc,
  deleteDoc,
  serverTimestamp,
} from "firebase/firestore";

const PROJECT_ID = "expenses-9af61";
const RULES_PATH = "./firestore.rules";

let testEnv;

// テスト用サブスクリプションデータ
const activeSub = {
  status: "active",
  plan: "trial",
  currentPeriodEnd: Math.floor(Date.now() / 1000) + 86400 * 30, // 30日後
};
const expiredSub = {
  status: "active",
  plan: "trial",
  currentPeriodEnd: Math.floor(Date.now() / 1000) - 86400, // 昨日
};
const betaSub = {
  status: "active",
  plan: "beta",
  currentPeriodEnd: 9999999999,
};

const validExpense = {
  amount: 1500,
  date: "2026-08-08",
  store: "イオン",
  category: "食費",
};

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
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

// ---------------------------------------------------------------------------
// ヘルパー: サブスクリプションを Admin SDK 相当で書き込む
// ---------------------------------------------------------------------------
async function setSubscription(uid, subData) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), `users/${uid}/settings/subscription`),
      subData
    );
  });
}

// ---------------------------------------------------------------------------
// 未認証アクセス
// ---------------------------------------------------------------------------

describe("未認証アクセス", () => {
  test("expenses の read が拒否される", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "users/user1/expenses/exp1")));
  });

  test("expenses の write が拒否される", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, "users/user1/expenses/exp1"), validExpense));
  });

  test("subscription の read が拒否される", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "users/user1/settings/subscription")));
  });
});

// ---------------------------------------------------------------------------
// A01: アクセス制御 — 他ユーザーデータ保護
// ---------------------------------------------------------------------------

describe("他ユーザーデータ保護", () => {
  test("他ユーザーの expenses を read できない", async () => {
    const db = testEnv.authenticatedContext("user2").firestore();
    await assertFails(getDoc(doc(db, "users/user1/expenses/exp1")));
  });

  test("他ユーザーの expenses に write できない", async () => {
    await setSubscription("user1", activeSub);
    const db = testEnv.authenticatedContext("user2").firestore();
    await assertFails(setDoc(doc(db, "users/user1/expenses/exp1"), validExpense));
  });

  test("他ユーザーの subscription を read できない", async () => {
    await setSubscription("user1", activeSub);
    const db = testEnv.authenticatedContext("user2").firestore();
    await assertFails(getDoc(doc(db, "users/user1/settings/subscription")));
  });
});

// ---------------------------------------------------------------------------
// expenses — プレミアム判定
// ---------------------------------------------------------------------------

describe("expenses — プレミアム判定", () => {
  test("有効なトライアル中は create できる", async () => {
    await setSubscription("user1", activeSub);
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertSucceeds(
      setDoc(doc(db, "users/user1/expenses/exp1"), validExpense)
    );
  });

  test("beta プランは create できる", async () => {
    await setSubscription("user1", betaSub);
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertSucceeds(
      setDoc(doc(db, "users/user1/expenses/exp1"), validExpense)
    );
  });

  test("期限切れトライアルは create できない", async () => {
    await setSubscription("user1", expiredSub);
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/expenses/exp1"), validExpense)
    );
  });

  test("subscription なしは create できない", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/expenses/exp1"), validExpense)
    );
  });

  test("有効なサブスク中は read できる", async () => {
    await setSubscription("user1", activeSub);
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertSucceeds(getDoc(doc(db, "users/user1/expenses/exp1")));
  });

  test("有効なサブスク中は delete できる", async () => {
    await setSubscription("user1", activeSub);
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertSucceeds(deleteDoc(doc(db, "users/user1/expenses/exp1")));
  });
});

// ---------------------------------------------------------------------------
// expenses — バリデーション
// ---------------------------------------------------------------------------

describe("expenses — バリデーション", () => {
  beforeEach(async () => {
    await setSubscription("user1", activeSub);
  });

  test("amount が負数は拒否", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/expenses/exp1"), { ...validExpense, amount: -1 })
    );
  });

  test("amount が 1 億以上は拒否", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/expenses/exp1"), { ...validExpense, amount: 100_000_000 })
    );
  });

  test("store が 100 文字超は拒否", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/expenses/exp1"), {
        ...validExpense,
        store: "あ".repeat(101),
      })
    );
  });

  test("memo が 500 文字超は拒否", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/expenses/exp1"), {
        ...validExpense,
        memo: "あ".repeat(501),
      })
    );
  });

  test("amount が数値でない場合は拒否", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/expenses/exp1"), {
        ...validExpense,
        amount: "千円",
      })
    );
  });
});

// ---------------------------------------------------------------------------
// subscription — クライアント書き込み禁止
// ---------------------------------------------------------------------------

describe("subscription — クライアント書き込み禁止", () => {
  test("本人でも subscription に直接書き込めない", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/settings/subscription"), activeSub)
    );
  });

  test("本人でも subscription を update できない", async () => {
    await setSubscription("user1", activeSub);
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertFails(
      updateDoc(doc(db, "users/user1/settings/subscription"), { status: "canceled" })
    );
  });

  test("subscription の read は本人のみ可", async () => {
    await setSubscription("user1", activeSub);
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertSucceeds(getDoc(doc(db, "users/user1/settings/subscription")));
  });
});

// ---------------------------------------------------------------------------
// settings (budget / shoppingList)
// ---------------------------------------------------------------------------

describe("settings — budget / shoppingList", () => {
  test("budget は本人が書き込める", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertSucceeds(
      setDoc(doc(db, "users/user1/settings/budget"), { food: 30000 })
    );
  });

  test("shoppingList は本人が書き込める", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertSucceeds(
      setDoc(doc(db, "users/user1/settings/shoppingList"), {
        items: [{ name: "牛乳", done: false }],
      })
    );
  });

  test("items が 200 件超は拒否", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/settings/shoppingList"), {
        items: Array(201).fill({ name: "x", done: false }),
      })
    );
  });

  test("他ユーザーの budget には書き込めない", async () => {
    const db = testEnv.authenticatedContext("user2").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/settings/budget"), { food: 30000 })
    );
  });
});

// ---------------------------------------------------------------------------
// mealPlans
// ---------------------------------------------------------------------------

describe("mealPlans", () => {
  const validMeal = { date: "2026-08-08", 夕食: "カレー" };

  test("本人は create できる", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertSucceeds(
      setDoc(doc(db, "users/user1/mealPlans/2026-08-08"), validMeal)
    );
  });

  test("本人は read できる", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertSucceeds(getDoc(doc(db, "users/user1/mealPlans/2026-08-08")));
  });

  test("本人は delete できる", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertSucceeds(deleteDoc(doc(db, "users/user1/mealPlans/2026-08-08")));
  });

  test("他ユーザーは create できない", async () => {
    const db = testEnv.authenticatedContext("user2").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/mealPlans/2026-08-08"), validMeal)
    );
  });

  test("レシピが 50000 文字超は拒否", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/mealPlans/2026-08-08"), {
        ...validMeal,
        夕食レシピ: "あ".repeat(50001),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// savedRecipes
// ---------------------------------------------------------------------------

describe("savedRecipes", () => {
  const validRecipe = {
    title: "チキンカレー",
    markdown: "## 材料\n- 鶏肉",
    items: ["鶏肉", "カレールー"],
    category: "カレー",
  };

  test("本人は create できる", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertSucceeds(
      setDoc(doc(db, "users/user1/savedRecipes/recipe1"), validRecipe)
    );
  });

  test("他ユーザーは create できない", async () => {
    const db = testEnv.authenticatedContext("user2").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/savedRecipes/recipe1"), validRecipe)
    );
  });

  test("title が 200 文字超は拒否", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/savedRecipes/recipe1"), {
        ...validRecipe,
        title: "あ".repeat(201),
      })
    );
  });

  test("items が 100 件超は拒否", async () => {
    const db = testEnv.authenticatedContext("user1").firestore();
    await assertFails(
      setDoc(doc(db, "users/user1/savedRecipes/recipe1"), {
        ...validRecipe,
        items: Array(101).fill("食材"),
      })
    );
  });
});

// db-paths.js のテスト — 個人 / 世帯モード切替。
import { describe, it, expect, beforeEach } from "vitest";
import { dbSetUser, dbSetHousehold, dbClearHousehold, dbGetHousehold, dbBase } from "./db-paths.js";

// モジュール状態は各テスト前にリセット
beforeEach(() => {
  dbSetUser(null);
  dbClearHousehold();
});

describe("dbBase", () => {
  it("returns users path when no household is set", () => {
    dbSetUser("user-123");
    expect(dbBase()).toEqual(["users", "user-123"]);
  });

  it("returns households path when household is set", () => {
    dbSetUser("user-123");
    dbSetHousehold("hh-abc");
    expect(dbBase()).toEqual(["households", "hh-abc"]);
  });

  it("returns users path after clearing household", () => {
    dbSetUser("user-456");
    dbSetHousehold("hh-xyz");
    dbClearHousehold();
    expect(dbBase()).toEqual(["users", "user-456"]);
  });
});

describe("dbGetHousehold", () => {
  it("returns null initially", () => {
    expect(dbGetHousehold()).toBeNull();
  });

  it("returns the household id after set", () => {
    dbSetHousehold("hh-789");
    expect(dbGetHousehold()).toBe("hh-789");
  });

  it("returns null after clear", () => {
    dbSetHousehold("hh-789");
    dbClearHousehold();
    expect(dbGetHousehold()).toBeNull();
  });
});

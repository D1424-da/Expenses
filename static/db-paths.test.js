// db-paths.js のテスト — 個人モードのパス解決。
import { describe, it, expect, beforeEach } from "vitest";
import { dbSetUser, dbBase } from "./db-paths.js";

beforeEach(() => {
  dbSetUser(null);
});

describe("dbBase", () => {
  it("returns users path for given uid", () => {
    dbSetUser("user-123");
    expect(dbBase()).toEqual(["users", "user-123"]);
  });

  it("returns users path after uid change", () => {
    dbSetUser("user-123");
    dbSetUser("user-456");
    expect(dbBase()).toEqual(["users", "user-456"]);
  });
});

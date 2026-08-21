// api-client.js の検証。
//
// 認証ヘッダの組み立てを間違えると全APIが401になり、
// エラー本文の取り出しを間違えると利用者に「HTTP 500」しか出せなくなる。
// fetch をスタブして、送信内容と例外の中身を固定する。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiFetch, apiJson, errorDetail } from "./api-client.js";
import { OCR_API_BASE } from "./firebase-config.js";

/** fetch を差し替え、呼び出し引数を記録する。 */
function stubFetch(response) {
  const calls = [];
  globalThis.fetch = vi.fn((url, init) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(response);
  });
  return calls;
}

const jsonRes = (body, { ok = true, status = 200 } = {}) => ({
  ok, status, json: () => Promise.resolve(body),
});

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe("apiFetch", () => {
  it("OCR_API_BASE を前置した URL を叩く", async () => {
    const calls = stubFetch(jsonRes({}));
    await apiFetch("/api/health");
    expect(calls[0].url).toBe(`${OCR_API_BASE}/api/health`);
  });

  it("token を渡すと Authorization ヘッダを付ける", async () => {
    const calls = stubFetch(jsonRes({}));
    await apiFetch("/api/x", { token: "abc123" });
    expect(calls[0].init.headers.Authorization).toBe("Bearer abc123");
  });

  it("token 未指定なら Authorization を付けない", async () => {
    const calls = stubFetch(jsonRes({}));
    await apiFetch("/api/x");
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  it("body を渡すと JSON 化し Content-Type を付ける", async () => {
    const calls = stubFetch(jsonRes({}));
    await apiFetch("/api/x", { method: "POST", body: { a: 1 } });
    expect(calls[0].init.body).toBe('{"a":1}');
    expect(calls[0].init.headers["Content-Type"]).toBe("application/json");
  });

  it("body 未指定なら body も Content-Type も送らない", async () => {
    const calls = stubFetch(jsonRes({}));
    await apiFetch("/api/x");
    expect(calls[0].init.body).toBeUndefined();
    expect(calls[0].init.headers["Content-Type"]).toBeUndefined();
  });

  it("params をクエリ文字列にする", async () => {
    const calls = stubFetch(jsonRes({}));
    await apiFetch("/api/x", { params: { name: "a/b c", w: 200 } });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("name")).toBe("a/b c"); // エンコードは URL 任せ
    expect(url.searchParams.get("w")).toBe("200");
  });

  // ページトークンが無いときに "page_token=null" を送ってしまわないこと
  it("null / undefined / 空文字の params は送らない", async () => {
    const calls = stubFetch(jsonRes({}));
    await apiFetch("/api/x", { params: { a: null, b: undefined, c: "", d: "ok" } });
    const url = new URL(calls[0].url);
    expect(url.searchParams.has("a")).toBe(false);
    expect(url.searchParams.has("b")).toBe(false);
    expect(url.searchParams.has("c")).toBe(false);
    expect(url.searchParams.get("d")).toBe("ok");
  });
});

describe("apiJson", () => {
  it("成功時はパース済みの JSON を返す", async () => {
    stubFetch(jsonRes({ status: "active" }));
    expect(await apiJson("/api/x")).toEqual({ status: "active" });
  });

  it("失敗時は FastAPI の detail を message にして throw する", async () => {
    stubFetch(jsonRes({ detail: "管理者権限がありません。" }, { ok: false, status: 403 }));
    await expect(apiJson("/api/x")).rejects.toThrow("管理者権限がありません。");
  });

  it("detail が無ければ HTTP ステータスを message にする", async () => {
    stubFetch(jsonRes({}, { ok: false, status: 500 }));
    await expect(apiJson("/api/x")).rejects.toThrow("HTTP 500");
  });

  // 502 のとき本文が HTML のことがある。JSON パース失敗で落とさない。
  it("本文が JSON でなくても throw の形を保つ", async () => {
    stubFetch({ ok: false, status: 502, json: () => Promise.reject(new Error("not json")) });
    await expect(apiJson("/api/x")).rejects.toThrow("HTTP 502");
  });
});

describe("errorDetail", () => {
  it("detail を優先し、無ければ HTTP ステータス", async () => {
    expect(await errorDetail(jsonRes({ detail: "だめ" }, { ok: false, status: 400 }))).toBe("だめ");
    expect(await errorDetail(jsonRes({}, { ok: false, status: 404 }))).toBe("HTTP 404");
  });
});

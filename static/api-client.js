// バックエンド（Render の FastAPI）への認証付きリクエストをまとめる。
//
// 各所で「getIdToken() → Authorization ヘッダを組む → res.ok を見る →
// FastAPI の {"detail": "..."} を取り出す」を書き写していた。同じことを
// 5ファイル11箇所でやっており、エラー本文の取り出し方だけが微妙に違った。
//
// ここに集約していないもの（意図的）:
//   - ocr-client.js  … AbortController でタイムアウトさせ、固まったら
//                       ブラウザ内 PaddleOCR にフォールバックする
//   - recipe-view.js … 接続エラー時に15秒待って1回だけ再試行する
// どちらも Render 無料枠のコールドスタート対策だが方式が違う。無理に
// 統合すると、片方の挙動をもう片方に押し付けることになるので触らない。
import { OCR_API_BASE } from "./firebase-config.js";

/** FastAPI のエラー応答から表示用の文言を取り出す。 */
async function _detail(res) {
  // 本文が JSON でないこともある（502 の HTML など）。その場合は握りつぶす。
  const body = await res.json().catch(() => ({}));
  return body.detail || `HTTP ${res.status}`;
}

/**
 * 認証付きで API を呼び、JSON を返す。res.ok でなければ throw する。
 *
 * トークンは呼び出し側が渡す。この関数から `auth` や現在のユーザーを
 * 参照しにいくと、どの認証状態で叩いたのかが呼び出し側から見えなくなる。
 *
 * @param {string} path            "/api/stripe/portal" のような絶対パス
 * @param {object} [opts]
 * @param {string} [opts.token]    Firebase ID トークン。省略時は認証ヘッダなし
 * @param {string} [opts.method]   既定 "GET"
 * @param {object} [opts.body]     指定すると JSON 化して送る（Content-Type も付く）
 * @param {object} [opts.params]   クエリ文字列
 * @returns {Promise<any>} パースした JSON
 * @throws {Error} 応答が res.ok でないとき。message は FastAPI の detail
 */
export async function apiJson(path, { token, method = "GET", body, params } = {}) {
  const res = await apiFetch(path, { token, method, body, params });
  if (!res.ok) throw new Error(await _detail(res));
  return res.json();
}

/**
 * 認証付きで API を呼び、Response をそのまま返す。
 *
 * 画像のように JSON でない応答を扱う場合や、res.ok でないときに
 * throw ではなく画面表示で処理したい場合に使う。
 */
export async function apiFetch(path, { token, method = "GET", body, params } = {}) {
  const url = new URL(OCR_API_BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
  }
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  return fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export { _detail as errorDetail };

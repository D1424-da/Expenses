# Verify skill — カケイシピ

## サーバー起動

```bash
# バックエンド（ポート8787、すでに起動済みなら不要）
FIREBASE_PROJECT_ID=expenses-9af61 uvicorn main:app --host 127.0.0.1 --port 8787 &
sleep 3
curl -s http://127.0.0.1:8787/api/health  # {"status":"ok"} を確認
```

## Playwright

```python
executable_path="/opt/pw-browsers/chromium"
args=["--no-sandbox","--disable-dev-shm-usage"]
```

## 主なURL（ローカル）

- `http://127.0.0.1:8787/login.html` — ログイン画面（メール・Googleログイン）
- `http://127.0.0.1:8787/index.html` — LP
- `http://127.0.0.1:8787/blog.html` — ブログ一覧
- `http://127.0.0.1:8787/blog/savings-life.html` — ブログ記事サンプル

## 注意

- `http://127.0.0.1:8787/` は Firebase Hosting の `**` rewrite がないため `index.html`（LP）を返す。
  本番では `login.html` が返る。ログイン画面テストは `/login.html` に直接アクセスすること。
- `google-auth` のトークン検証はこの環境で `_cffi_backend` が欠損して `PanicException`（BaseException）を投げ、
  500になる。本番Renderでは正常に401を返す。認証テストはAPI単体ではなくFirebase認証フロー込みで行うこと。
- Firebase AuthはGoogleアカウントが必要なため、Playwright単体での新規登録・ログイン完結テストは不可。
  APIレベルのauth確認は偽トークン → 401/500 で境界を確認する。

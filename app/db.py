"""SQLite データアクセス層。

標準ライブラリの sqlite3 のみを使い、追加依存なしで家計簿データを保存する。
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "expenses.db"

# 標準的な家計簿のカテゴリ。フロント側のセレクトと共有する。
CATEGORIES = [
    "食費",
    "日用品",
    "外食",
    "交通費",
    "医療費",
    "娯楽",
    "衣服",
    "光熱費",
    "通信費",
    "その他",
]


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    conn = _connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    """テーブルを作成する（存在しなければ）。"""
    with get_conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS expenses (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                date        TEXT    NOT NULL,           -- YYYY-MM-DD
                store       TEXT    NOT NULL DEFAULT '',
                amount      INTEGER NOT NULL DEFAULT 0, -- 円（整数）
                category    TEXT    NOT NULL DEFAULT 'その他',
                memo        TEXT    NOT NULL DEFAULT '',
                items       TEXT    NOT NULL DEFAULT '[]', -- JSON配列 [{name, price}]
                image_path  TEXT,
                raw_text    TEXT,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
            )
            """
        )


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    try:
        d["items"] = json.loads(d.get("items") or "[]")
    except (json.JSONDecodeError, TypeError):
        d["items"] = []
    return d


def create_expense(data: dict[str, Any]) -> dict[str, Any]:
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO expenses (date, store, amount, category, memo, items, image_path, raw_text)
            VALUES (:date, :store, :amount, :category, :memo, :items, :image_path, :raw_text)
            """,
            {
                "date": data["date"],
                "store": data.get("store", ""),
                "amount": int(data.get("amount", 0) or 0),
                "category": data.get("category", "その他"),
                "memo": data.get("memo", ""),
                "items": json.dumps(data.get("items", []), ensure_ascii=False),
                "image_path": data.get("image_path"),
                "raw_text": data.get("raw_text"),
            },
        )
        new_id = cur.lastrowid
    return get_expense(new_id)  # type: ignore[return-value]


def get_expense(expense_id: int) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM expenses WHERE id = ?", (expense_id,)
        ).fetchone()
    return _row_to_dict(row) if row else None


def list_expenses(
    month: str | None = None, category: str | None = None
) -> list[dict[str, Any]]:
    query = "SELECT * FROM expenses"
    clauses: list[str] = []
    params: list[Any] = []
    if month:  # 'YYYY-MM'
        clauses.append("substr(date, 1, 7) = ?")
        params.append(month)
    if category:
        clauses.append("category = ?")
        params.append(category)
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY date DESC, id DESC"
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
    return [_row_to_dict(r) for r in rows]


def update_expense(expense_id: int, data: dict[str, Any]) -> dict[str, Any] | None:
    existing = get_expense(expense_id)
    if not existing:
        return None
    merged = {**existing, **data}
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE expenses
               SET date = :date, store = :store, amount = :amount,
                   category = :category, memo = :memo, items = :items
             WHERE id = :id
            """,
            {
                "id": expense_id,
                "date": merged["date"],
                "store": merged.get("store", ""),
                "amount": int(merged.get("amount", 0) or 0),
                "category": merged.get("category", "その他"),
                "memo": merged.get("memo", ""),
                "items": json.dumps(merged.get("items", []), ensure_ascii=False),
            },
        )
    return get_expense(expense_id)


def delete_expense(expense_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
    return cur.rowcount > 0


def monthly_summary(month: str) -> dict[str, Any]:
    """指定月（YYYY-MM）の合計とカテゴリ別内訳を返す。"""
    expenses = list_expenses(month=month)
    total = sum(e["amount"] for e in expenses)
    by_category: dict[str, int] = {}
    for e in expenses:
        by_category[e["category"]] = by_category.get(e["category"], 0) + e["amount"]
    return {
        "month": month,
        "total": total,
        "count": len(expenses),
        "by_category": by_category,
    }

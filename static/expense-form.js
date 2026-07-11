// フォームの入力・編集・削除。Firebase への書き込みも担当する。
//
// initForm(ctx) で初期化し、OCR完了時は fillForm()、一覧の編集ボタンは
// editExpense() を呼ぶ。保存完了後は ctx.onSaved(dateStr, wasEdit) に通知する。
import {
  doc, addDoc, updateDoc, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { CATEGORIES } from "./firebase-config.js";
import { dbBase } from "./db-paths.js";
import { log, logErr } from "./log.js";
import { $, todayStr, escapeHtml, closeModal } from "./dom-utils.js";
import { invalidateHistoryDict, TRUSTED_ENGINES } from "./history.js";

let _ctx;
let _previewUrl = null;

export function initForm(ctx) {
  _ctx = ctx;
  $("expense-form").onsubmit = _handleSubmit;
  $("reset-btn").onclick = resetForm;

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "＋ 明細を追加";
  addBtn.style.marginTop = "8px";
  addBtn.onclick = () => { _addItemRow(); _updateItemsCount(); };
  $("items-details").appendChild(addBtn);
}

// OCR結果をフォームに流し込む。編集モードを解除してから埋める。
export function fillForm(data, previewUrl) {
  setFormMode("add");
  $("form-title").textContent = "読み取り結果を確認";
  $("f-id").value = "";
  $("f-date").value = data.date || todayStr();
  $("f-amount").value = data.amount || 0;
  $("f-store").value = data.store || "";
  $("f-branch").value = data.branch || "";
  $("f-category").value = data.category || "その他";
  $("f-memo").value = "";
  $("f-image-url").value = "";
  $("f-rawtext").value = data.raw_text || "";
  $("f-engine").value = data.engine || "";
  _renderItems(data.items || []);
  _showPreview(previewUrl);
}

export function resetForm() {
  $("expense-form").reset();
  $("f-id").value = "";
  $("f-image-url").value = "";
  $("f-rawtext").value = "";
  $("f-engine").value = "manual";
  $("items-list").innerHTML = "";
  _showPreview(null);
  _updateItemsCount();
  $("f-date").value = todayStr();
  setFormMode("add");
}

export function editExpense(e) {
  $("f-id").value = e.id;
  $("f-date").value = e.date;
  $("f-amount").value = e.amount;
  $("f-store").value = e.store || "";
  $("f-branch").value = e.branch || "";
  $("f-category").value = e.category;
  $("f-memo").value = e.memo || "";
  $("f-engine").value = e.ocrEngine || "";
  _renderItems(e.items || []);
  _showPreview(null);
  setFormMode("edit", e);
  closeModal("day-modal");
  $("form-card").scrollIntoView({ behavior: "smooth" });
}

export async function deleteExpense(id) {
  if (!confirm("この記録を削除しますか?")) return;
  try {
    await deleteDoc(doc(_ctx.db, ...dbBase(), "expenses", id));
  } catch (err) {
    alert("削除に失敗しました: " + err.message);
  }
}

export function setFormMode(mode, e) {
  const editing = mode === "edit";
  $("form-card").classList.toggle("editing", editing);
  $("form-title").textContent = editing ? "支出を編集" : "手入力で追加";
  $("save-btn").textContent = editing ? "更新する" : "保存";
  $("reset-btn").textContent = editing ? "編集をやめる" : "クリア";
  const banner = $("edit-banner");
  if (editing && e) {
    const where = [e.store || "(店名なし)", e.branch].filter(Boolean).join(" ");
    banner.textContent = `編集中: ${where} ・ ${e.date}`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function _showPreview(url) {
  if (_previewUrl && _previewUrl !== url) {
    URL.revokeObjectURL(_previewUrl);
    _previewUrl = null;
  }
  if (url) {
    _previewUrl = url;
    $("preview-img").src = url;
    $("form-preview").hidden = false;
  } else {
    $("preview-img").removeAttribute("src");
    $("form-preview").hidden = true;
  }
}

function _renderItems(items) {
  $("items-list").innerHTML = "";
  for (const it of items) _addItemRow(it.name, it.price, it.category, it.qty, it.unit);
  _updateItemsCount();
}

function _addItemRow(name = "", price = 0, category = "", qty = "", unit = "") {
  const row = document.createElement("div");
  row.className = "item-row";
  let selected = category || $("f-category").value || "その他";
  if (!CATEGORIES.includes(selected)) selected = "その他";
  const options = CATEGORIES.map(
    (c) => `<option value="${c}"${c === selected ? " selected" : ""}>${c}</option>`,
  ).join("");
  row.innerHTML = `
    <div class="item-row-main">
      <input type="text" class="item-name" value="${escapeHtml(name)}" placeholder="品目" />
      <input type="number" class="item-price" value="${price || 0}" min="0" step="1" inputmode="numeric" />
      <select class="item-category" aria-label="明細カテゴリ">${options}</select>
      <button type="button" aria-label="削除">✕</button>
    </div>
    <div class="item-row-qty">
      <input type="number" class="item-qty" value="${qty ?? ""}" min="0" step="0.1" inputmode="decimal" placeholder="数量" />
      <input type="text" class="item-unit" value="${escapeHtml(unit ?? "")}" placeholder="g / 個 / 袋" maxlength="6" />
      <span class="item-qty-label">↑ 入力するとレシピ精度が上がります（任意）</span>
    </div>`;
  row.querySelector("button").onclick = () => { row.remove(); _updateItemsCount(); };
  $("items-list").appendChild(row);
}

function _collectItems() {
  return [...document.querySelectorAll(".item-row")]
    .map((r) => {
      const qtyVal = r.querySelector(".item-qty").value;
      const unitVal = r.querySelector(".item-unit").value.trim();
      const item = {
        name: r.querySelector(".item-name").value.trim(),
        price: Number(r.querySelector(".item-price").value) || 0,
        category: r.querySelector(".item-category").value,
      };
      if (qtyVal !== "") item.qty = Number(qtyVal);
      if (unitVal) item.unit = unitVal;
      return item;
    })
    .filter((it) => it.name || it.price);
}

function _updateItemsCount() {
  const count = document.querySelectorAll(".item-row").length;
  $("items-count").textContent = count;
  const hint = $("items-qty-global-hint");
  if (hint) hint.hidden = count === 0;
}

async function _handleSubmit(e) {
  e.preventDefault();
  const saveBtn = $("save-btn");
  const id = $("f-id").value;

  // 新規保存のみ課金ゲートを通す（編集は常に許可）
  if (!id && _ctx.onBeforeSave) {
    const allowed = await _ctx.onBeforeSave();
    if (!allowed) return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "保存中…";
  try {
    const user = _ctx.getUser();
    const engine = $("f-engine").value;
    const payload = {
      date: $("f-date").value,
      store: $("f-store").value.trim(),
      branch: $("f-branch").value.trim(),
      amount: Number($("f-amount").value) || 0,
      category: $("f-category").value,
      memo: $("f-memo").value.trim(),
      items: _collectItems(),
      // 編集時: 信頼エンジン由来ならそのまま保持、それ以外は "edited" に昇格させて
      // 次回正規化の正解辞書に含める（楽天家計簿方式の学習）。
      ocrEngine: id
        ? (TRUSTED_ENGINES.includes(engine) ? engine : "edited")
        : (engine || "manual"),
    };
    log(id ? "更新:" : "新規保存:", payload);
    if (id) {
      await updateDoc(doc(_ctx.db, ...dbBase(), "expenses", id), payload);
    } else {
      await addDoc(_ctx.expensesCol(), {
        ...payload,
        rawText: $("f-rawtext").value || "",
        createdAt: serverTimestamp(),
      });
    }
    log("保存成功");
    invalidateHistoryDict();
    const wasEdit = !!id;
    const dateStr = $("f-date").value;
    resetForm();
    _ctx.onSaved(dateStr, wasEdit);
  } catch (err) {
    logErr("保存エラー:", err.code, err.message, err);
    alert("保存に失敗しました: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = id && $("f-id").value ? "更新する" : "保存";
  }
}

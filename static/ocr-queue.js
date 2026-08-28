// OCRキュー: 複数画像の順次処理・スキップ・ブラウザ内フォールバック。
import { state } from "./app-state.js";
import { $, dayKey } from "./dom-utils.js";
import { OCR_API_BASE } from "./firebase-config.js";
import { log, logErr } from "./log.js";
import { requestBackendOcr, preprocessImage, runClientOcr, prewarmOcr } from "./ocr-client.js";
import { parseReceipt } from "./parser.js";
import { TRUSTED_ENGINES, normalizeWithHistory } from "./history.js";
import { fillForm, resetForm, openForm } from "./expense-form.js";
import { fetchAllExpenses } from "./firestore-data.js";

export { prewarmOcr };

let ocrQueue = [];
let ocrTotal = 0;

export function handleFiles(e) {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  ocrQueue = files;
  ocrTotal = files.length;
  _processNext();
}

function _queuePrefix() {
  if (ocrTotal <= 1) return "";
  return `(${ocrTotal - ocrQueue.length}/${ocrTotal}枚目) `;
}

function _processNext() {
  if (!ocrQueue.length) { ocrTotal = 0; $("skip-btn").hidden = true; return; }
  $("skip-btn").hidden = ocrTotal <= 1;
  _ocrAndShow(ocrQueue.shift());
}

/** キューを進める。残りがあれば true を返す。 */
export function advanceQueue() {
  if (ocrQueue.length) { _processNext(); return true; }
  if (ocrTotal > 1) {
    const s = $("ocr-status");
    s.hidden = false;
    s.className = "status ok";
    s.textContent = `✅ ${ocrTotal}枚すべて処理しました。`;
  }
  ocrTotal = 0;
  $("skip-btn").hidden = true;
  return false;
}

export function skipCurrent() {
  resetForm();
  if (!advanceQueue()) $("ocr-status").hidden = true;
}

async function _ocrInBrowser(file, status) {
  const canvas = await preprocessImage(file);
  const text   = await runClientOcr(canvas, (p) => {
    status.textContent = `🔍 文字を読み取り中… ${Math.round(p * 100)}%`;
  });
  return parseReceipt(text);
}

async function _ocrAndShow(file) {
  log("OCR開始:", file.name, file.type, `${Math.round(file.size / 1024)}KB`,
    OCR_API_BASE ? "(バックエンド)" : "(ブラウザ内PaddleOCR)");
  const status = $("ocr-status");
  status.hidden = false;
  status.className = "status loading";
  status.textContent = `📤 ${_queuePrefix()}読み取り中… (数秒かかります)`;
  try {
    let data;
    if (OCR_API_BASE) {
      try {
        status.textContent = "🤖 AIで読み取り中…";
        data = await requestBackendOcr(
          file,
          () => (state.currentUser ? state.currentUser.getIdToken() : ""),
          () => { status.textContent = "🤖 AIサーバーを起動中…（初回は少し時間がかかります）"; },
        );
        const used = data.engine || "不明";
        log("バックエンド読み取り成功:", `エンジン=${used}`);
        if (!TRUSTED_ENGINES.includes(used)) {
          logErr(`⚠️ Gemini/Vertex を使えず ${used} にフォールバックしました。AI のキー/課金状態を確認してください。`);
        }
      } catch (err) {
        logErr("バックエンドOCR失敗、ブラウザ内PaddleOCRに切替:", err.message, err);
        status.textContent = "🔍 文字を読み取り中…（PaddleOCR・初回はモデル取得で時間がかかります）";
        data = await _ocrInBrowser(file, status);
      }
    } else {
      data = await _ocrInBrowser(file, status);
    }
    log("OCR完了。抽出結果:", data);
    if (data && !TRUSTED_ENGINES.includes(data.engine)) {
      data = await normalizeWithHistory(data, fetchAllExpenses);
    }
    fillForm(data, URL.createObjectURL(file));
    // AI(Gemini/Vertex)が使えず簡易OCRに切り替わった場合は精度が落ちるため、
    // 黙って不正確な内容が保存されないよう明示的に注意を促す。
    const lowAccuracy = data && !TRUSTED_ENGINES.includes(data.engine);
    status.className = lowAccuracy ? "status warn" : "status ok";
    status.textContent = lowAccuracy
      ? `⚠️ ${_queuePrefix()}簡易読み取りのため精度が低い可能性があります。`
        + `金額・店名・明細をご確認のうえ保存してください。`
        + (ocrTotal > 1 ? "（保存すると次の画像へ進みます）" : "")
      : `✅ ${_queuePrefix()}読み取りました。内容を確認して保存してください。`
        + (ocrTotal > 1 ? "（保存すると次の画像へ進みます）" : "");
    // 状態表示（#ocr-status）はフォームより上にあり、簡易読み取りの注意文で
    // 3行に伸びる。fillForm 内の openForm() はその前に位置を計算しているので、
    // 文言が確定したここで開き直して位置を取り直す。
    // scrollIntoView は使わない — sticky なヘッダーの裏にフォームの先頭が
    // 隠れる（expense-form.js の openForm がその理由で window.scrollTo を使う）。
    openForm();
  } catch (err) {
    logErr("OCRエラー:", err.message || err, err);
    status.className = "status error";
    status.textContent = `⚠️ ${_queuePrefix()}` + (err.message || err) +
      (ocrTotal > 1 ? "（「スキップ」で次へ進めます）" : "");
  }
}

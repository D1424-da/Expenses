// OCR クライアント — 画像の縮小/前処理、バックエンド(FastAPI)呼び出し、
// ブラウザ内 PaddleOCR（最終フォールバック）をまとめたモジュール。
import { OCR_API_BASE } from "./firebase-config.js";
import { log, logErr } from "./log.js";

// AI(Gemini)へ送る画像を縮小＋JPEG再圧縮する。長辺1600pxあればレシートの
// 文字は十分読め、数MBの写真が数百KBになりアップロードもAI処理も速くなる。
// createImageBitmap が失敗する形式（HEIC 等）では元ファイルをそのまま返す。
const UPLOAD_MAX_DIM = 1600;
const UPLOAD_JPEG_QUALITY = 0.85;

// 長辺 maxDim までに縮小して canvas に描く共通処理。
async function drawScaled(file, maxDim) {
  const img = await createImageBitmap(file);
  const longSide = Math.max(img.width, img.height);
  const scale = longSide > maxDim ? maxDim / longSide : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close?.();
  return { canvas, scale };
}

export async function downscaleForUpload(file) {
  try {
    const { canvas, scale } = await drawScaled(file, UPLOAD_MAX_DIM);
    // 既に十分小さいJPEGなら再圧縮せずそのまま使う。
    if (scale === 1 && file.type === "image/jpeg") return file;
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", UPLOAD_JPEG_QUALITY)
    );
    if (!blob) return file; // 失敗時は元ファイルにフォールバック
    log("アップロード用に縮小:", `${Math.round(file.size / 1024)}KB → ${Math.round(blob.size / 1024)}KB`);
    return blob;
  } catch (err) {
    logErr("画像の縮小に失敗（元画像を送信）:", err.message);
    return file;
  }
}

// PaddleOCR(PP-OCR)は自然画像（カラー）で学習されているため、Tesseract時代の
// ような二値化は行わず、原画像のまま渡すほうが精度が出る。大きすぎる写真は
// メモリ・速度のため長辺1600pxに縮小するだけにする。
export async function preprocessImage(file) {
  const { canvas } = await drawScaled(file, 1600);
  return canvas;
}

// ---- バックエンド(FastAPI)呼び出し -------------------------------------------
// 高精度AI(Gemini)もここ経由。キーはサーバー側の環境変数に保持し、
// フロントは OCR_API_BASE を呼ぶだけにする。
// getIdToken: 認証ヘッダ用のトークン取得関数（バックエンドが認証必須で
// なくても付与は無害）。onWakeup: 起動待ちが長いときの表示更新コールバック。
export async function requestBackendOcr(file, getIdToken, onWakeup) {
  // 元画像（スマホ写真は数MB）をそのまま送ると、アップロードとAI処理の
  // 両方が遅くなる。送信前に縮小してJPEGに再圧縮する。
  const upload = await downscaleForUpload(file);
  const fd = new FormData();
  fd.append("file", upload, "receipt.jpg");
  const headers = {};
  try {
    const token = await getIdToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch (e) { logErr("IDトークン取得失敗（認証なしで続行）:", e.message); }
  // Render 無料枠はアイドルで停止し、初回は起動に時間がかかる。タイムアウトと
  // 「起動待ち」表示を入れ、固まったらブラウザ内OCRへフォールバックさせる。
  const ctrl = new AbortController();
  const wakeTimer = setTimeout(() => onWakeup?.(), 4000);
  const killTimer = setTimeout(() => ctrl.abort(), 90000); // 90秒で打ち切り
  let res;
  try {
    res = await fetch(`${OCR_API_BASE}/api/ocr`, {
      method: "POST", body: fd, headers, signal: ctrl.signal,
    });
  } finally {
    clearTimeout(wakeTimer);
    clearTimeout(killTimer);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "読み取りに失敗しました");
  }
  return res.json();
}

// ---- ブラウザ内OCR: PaddleOCR (ppu-paddle-ocr + onnxruntime-web) -------------
// Gemini→Vision が両方失敗したときの最終フォールバック。ESM/モデルは初回利用時に
// CDN から取得する（合計約21MB、以降はブラウザのHTTPキャッシュが効く）。
//
// 採用モデル: PP-OCRv5 mobile の汎用モデル。日中英＋日本語を1つの認識モデルで扱える。
// 必要に応じて URL を差し替えれば別言語・サーバーモデルにも切替可能。
const PADDLE_ESM = "https://esm.sh/ppu-paddle-ocr@5.8.3/web";
const PADDLE_MEDIA_BASE = "https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/refs/heads/main";
const PADDLE_RAW_BASE = "https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/refs/heads/main";
const PADDLE_MODELS = {
  detection: `${PADDLE_MEDIA_BASE}/detection/PP-OCRv5_mobile_det_infer.onnx`,
  recognition: `${PADDLE_MEDIA_BASE}/recognition/PP-OCRv5_mobile_rec_infer.onnx`,
  charactersDictionary: `${PADDLE_RAW_BASE}/recognition/ppocrv5_dict.txt`,
};

// 高速化のポイント: サービス（WASM/WebGPU セッション＋モデル）の初期化は重いので、
// 1度だけ作って使い回す。2枚目以降や事前ウォームアップ済みなら大幅に速くなる。
let paddleServicePromise = null;

function getPaddleOcr() {
  if (!paddleServicePromise) {
    log("PaddleOCRを初期化中…（初回のみモデル取得・約21MB）");
    paddleServicePromise = (async () => {
      // 動的 import。読み込めなければネットワーク/CDNの問題として扱う。
      const mod = await import(/* @vite-ignore */ PADDLE_ESM);
      const PaddleOcrService = mod.PaddleOcrService || mod.default?.PaddleOcrService;
      if (!PaddleOcrService) {
        throw new Error("PaddleOCRライブラリの読み込みに失敗しました。");
      }
      const service = new PaddleOcrService({ model: PADDLE_MODELS });
      await service.initialize();
      log("PaddleOCR準備完了");
      return service;
    })().catch((err) => {
      // 失敗時は次回また作り直せるようにキャッシュを破棄
      paddleServicePromise = null;
      throw err;
    });
  }
  return paddleServicePromise;
}

// 初回の体感速度を上げるため、ログイン直後などに裏で言語データを読み込んでおく。
export function prewarmOcr() {
  if (OCR_API_BASE) {
    // バックエンド(Render無料プラン)はアクセスが無いとスリープし、次の
    // リクエストでコールドスタート(起動に数十秒)が発生する。アプリ起動時に
    // /api/health を叩いて先に起こしておけば、撮影中に起動が進み、最初の
    // 読み取りの待ち時間を大幅に短縮できる。
    fetch(`${OCR_API_BASE}/api/health`, { cache: "no-store" })
      .then((res) => res.json().catch(() => ({})))
      .then((h) =>
        log(
          "OCRバックエンド稼働:",
          `設定エンジン=${h.engine || "?"}`,
          h.status ? `status=${h.status}` : "",
          "(これは設定値。実際にGeminiが使えたかは読み取り時のログを参照)",
        ),
      )
      .catch((err) => logErr("OCRバックエンドのウォームアップに失敗:", err.message));
    return;
  }
  try {
    getPaddleOcr().catch((err) => logErr("OCR事前準備に失敗（実行時に再試行）:", err.message));
  } catch (err) {
    logErr("OCR事前準備をスキップ:", err.message);
  }
}

export async function runClientOcr(image, onProgress) {
  // PaddleOCR は Tesseract のような細かい進捗を返さないため、初期化→認識の
  // 大まかな段階だけ通知する。
  onProgress?.(0.1);
  const service = await getPaddleOcr();
  onProgress?.(0.6);
  const result = await service.recognize(image);
  onProgress?.(1);
  return result?.text || "";
}

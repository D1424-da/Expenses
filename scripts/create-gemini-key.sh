#!/usr/bin/env bash
#
# Gemini(Generative Language) API キーを作成するスクリプト。
#
# 使い方（Google Cloud Shell で実行）:
#   bash scripts/create-gemini-key.sh [PROJECT_ID]
#
# PROJECT_ID を省略すると現在の gcloud 設定のプロジェクトを使う。
#
# ⚠️ 出力されたキーは firebase-config.js には貼らないこと（公開され無効化される）。
#    バックエンドの環境変数 GEMINI_API_KEY に設定して使う。
#
set -euo pipefail

PROJECT_ID="${1:-$(gcloud config get-value project 2>/dev/null)}"
DISPLAY_NAME="receipt-ocr-gemini"
API_SERVICE="generativelanguage.googleapis.com"

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "エラー: プロジェクトIDが指定されていません。" >&2
  echo "  bash scripts/create-gemini-key.sh <PROJECT_ID>" >&2
  exit 1
fi

echo "▶ プロジェクト: ${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}" >/dev/null

echo "▶ Gemini API を有効化中…"
gcloud services enable "${API_SERVICE}"

# 同名のキーが既にあれば再利用し、二重作成を避ける。
EXISTING="$(gcloud services api-keys list \
  --filter="displayName=${DISPLAY_NAME}" \
  --format="value(name)" 2>/dev/null | head -n1)"

if [[ -n "${EXISTING}" ]]; then
  echo "▶ 既存のキー(${DISPLAY_NAME})を再利用します。"
  KEY_NAME="${EXISTING}"
else
  echo "▶ API キーを作成中（Gemini API 限定）…"
  gcloud services api-keys create \
    --display-name="${DISPLAY_NAME}" \
    --api-target="service=${API_SERVICE}"
  KEY_NAME="$(gcloud services api-keys list \
    --filter="displayName=${DISPLAY_NAME}" \
    --format="value(name)" | head -n1)"
fi

KEY_STRING="$(gcloud services api-keys get-key-string "${KEY_NAME}" \
  --format="value(keyString)")"

echo
echo "=================================================================="
echo "✅ Gemini API キーを取得しました:"
echo
echo "   ${KEY_STRING}"
echo
echo "次の手順（バックエンドの環境変数に設定）:"
echo "   OCR_ENGINE=gemini"
echo "   GEMINI_API_KEY=${KEY_STRING}"
echo
echo "⚠️ このキーを static/firebase-config.js やGitに貼らないでください。"
echo "=================================================================="

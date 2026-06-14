# OCRサービス(FastAPI + Tesseract)用コンテナ。
# Cloud Run などにそのままデプロイできる。
FROM python:3.11-slim

# Tesseract と日本語データ、OpenCV 実行時に必要なライブラリ
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-jpn \
        tesseract-ocr-jpn-vert \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY app/ ./app/
COPY static/ ./static/

# Cloud Run は環境変数 PORT でポートを渡す（既定 8080）
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]

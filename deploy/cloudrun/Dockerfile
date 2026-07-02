# FiNANCiE TIMES 日次更新ジョブ（Cloud Run Job）
# 起動時にリポジトリを clone → シート/データ取得・更新 → main へ push。
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir gspread google-auth playwright psutil requests beautifulsoup4
RUN playwright install --with-deps chromium

ENV TZ=Asia/Tokyo \
    PYTHONUNBUFFERED=1

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/run.sh"]

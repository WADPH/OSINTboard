# Backend image: FastAPI + maigret scan worker.
#
# The venv lives at /app/.venv because backend/main.py resolves the maigret
# binary as BASE_DIR/.venv/bin/maigret.

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000

# Runtime libraries maigret/reportlab need, plus curl for the healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libffi8 \
        libfreetype6 \
        libjpeg62-turbo \
        libxml2 \
        libxslt1.1 \
        zlib1g \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .

# Build a venv at the exact path main.py expects. Build-only toolchain is
# installed in the same layer and removed afterwards so it stays out of the
# final image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        libffi-dev \
        libfreetype6-dev \
        libjpeg62-turbo-dev \
        libxml2-dev \
        libxslt1-dev \
        zlib1g-dev \
    && python -m venv /app/.venv \
    && /app/.venv/bin/pip install --upgrade pip \
    && /app/.venv/bin/pip install -r requirements.txt \
    && apt-get purge -y --auto-remove \
        build-essential \
        libffi-dev \
        libfreetype6-dev \
        libjpeg62-turbo-dev \
        libxml2-dev \
        libxslt1-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/* /root/.cache

COPY main.py .

# Scan results and the graphs database/attachments are bind-mounted from the
# project folder (see docker-compose.yml).
RUN mkdir -p /app/results /app/data

EXPOSE 8000

# Bind on all interfaces so the nginx container can reach the API. Idle
# self-exit stays disabled (0) — a container should not stop on its own;
# docker-compose sets OSINTBOARD_IDLE_TIMEOUT=0 explicitly as well.
ENV OSINTBOARD_IDLE_TIMEOUT=0

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:8000/api/health" || exit 1

CMD ["/app/.venv/bin/uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

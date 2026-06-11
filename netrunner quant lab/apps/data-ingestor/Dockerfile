FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir fastapi==0.115.6 uvicorn[standard]==0.32.1 httpx==0.28.1 asyncpg==0.30.0 redis==5.2.1 orjson==3.10.12 websockets==14.1 prometheus-client==0.21.1
COPY apps/data-ingestor ./apps/data-ingestor
ENV PYTHONPATH=/app/apps/data-ingestor
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7100", "--app-dir", "/app/apps/data-ingestor"]

FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir fastapi==0.115.6 uvicorn[standard]==0.32.1 asyncpg==0.30.0 pydantic==2.10.4 prometheus-client==0.21.1
COPY apps/verifier ./apps/verifier
COPY packages/quant-core ./packages/quant-core
ENV PYTHONPATH=/app/apps/verifier:/app/packages/quant-core
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7200", "--app-dir", "/app/apps/verifier"]

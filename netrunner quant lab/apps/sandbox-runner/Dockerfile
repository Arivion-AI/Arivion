FROM python:3.11-slim
WORKDIR /app
RUN pip install --no-cache-dir fastapi==0.115.6 uvicorn[standard]==0.32.1 pydantic==2.10.4
COPY apps/sandbox-runner ./apps/sandbox-runner
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7300", "--app-dir", "/app/apps/sandbox-runner"]

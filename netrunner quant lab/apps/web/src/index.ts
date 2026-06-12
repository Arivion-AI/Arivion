import express from "express";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.WEB_PORT ?? 3000);
const apiUrl = process.env.API_URL ?? "http://api:4000";
const publicApiUrl = process.env.PUBLIC_API_URL ?? "http://localhost:4400";
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../public");

app.get("/health", async (_req, res) => {
  try {
    const response = await fetch(`${apiUrl}/health`);
    const api = await response.json();
    res.json({ ok: response.ok, service: "web", api });
  } catch (error) {
    res.status(503).json({ ok: false, service: "web", error: (error as Error).message });
  }
});

app.get("/config.js", (_req, res) => {
  res.type("application/javascript").send(`window.__APP_CONFIG__ = ${JSON.stringify({ apiUrl: publicApiUrl })};`);
});

app.use(express.static(publicDir));

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`web listening on :${port}`);
});

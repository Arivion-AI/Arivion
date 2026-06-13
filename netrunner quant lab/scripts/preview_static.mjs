import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = resolve(__dirname, "../apps/web/public");
const apiUrl = process.env.PUBLIC_API_URL ?? "http://localhost:4400";
const port = Number(process.env.PORT ?? 3399);
const types = { ".html":"text/html", ".js":"application/javascript", ".css":"text/css", ".json":"application/json" };
http.createServer(async (req, res) => {
  let url = req.url.split("?")[0];
  if (url === "/config.js") {
    res.setHeader("content-type","application/javascript");
    return res.end(`window.__APP_CONFIG__ = ${JSON.stringify({ apiUrl })};`);
  }
  if (url === "/") url = "/index.html";
  try {
    const buf = await readFile(resolve(dir, "." + url));
    res.setHeader("content-type", types[extname(url)] ?? "application/octet-stream");
    res.end(buf);
  } catch { res.statusCode = 404; res.end("not found"); }
}).listen(port, () => console.log(`preview static on :${port}`));

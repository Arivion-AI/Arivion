import { db } from "../db.js";
import { llmGateway } from "../llm-gateway/index.js";
import { logger } from "../logger.js";
import { chunkText } from "./chunk.js";

// A2 — knowledge INGESTION. Extract → structure-aware chunk → embed → store. Sources: raw text/markdown
// (native), a URL (fetched + HTML stripped — covers articles), or a PDF (guarded dynamic import of
// pdf-parse; falls back to an honest error if the dep isn't installed). Embeddings reuse the metered
// gateway (same model as memory, so dims match recall). owner_id NULL = global shelf.

function vecLiteral(vec: number[]): string { return `[${vec.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`; }

export interface IngestInput {
  ownerId: number;
  scope?: "owner" | "global";
  title?: string;
  author?: string;
  kind?: "book" | "paper" | "article" | "note";
  tags?: string[];
  text?: string;                 // raw text/markdown
  url?: string;                  // fetch + extract
  pdfBase64?: string;            // base64 PDF bytes
}

export interface IngestResult { docId: number | null; title: string; chunks: number; tokens: number; status: "ready" | "error"; error?: string }

// --- Extraction ---------------------------------------------------------------------------------
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|br|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractFromUrl(url: string): Promise<{ text: string; title?: string }> {
  const res = await fetch(url, { headers: { "User-Agent": "DualityCopilot/1.0" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (ct.includes("pdf") || url.toLowerCase().endsWith(".pdf")) return { text: await extractPdf(buf) };
  const html = buf.toString("utf8");
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return { text: ct.includes("html") ? stripHtml(html) : html, title: titleMatch?.[1]?.trim() };
}

async function extractPdf(bytes: Buffer): Promise<string> {
  try {
    // Optional dependency — present ⇒ real PDF extraction; absent ⇒ honest error (text/URL still work).
    // Use the lib entry (not the package index, which runs debug code that crashes under ESM import).
    // Indirect specifier so the type-checker doesn't require the module to be installed at build time.
    const spec = "pdf-parse/lib/pdf-parse.js";
    const mod = (await import(spec).catch(() => null)) as { default?: (b: Buffer) => Promise<{ text: string }> } | null;
    const parse = mod?.default ?? (mod as unknown as ((b: Buffer) => Promise<{ text: string }>) | null);
    if (!parse) throw new Error("pdf-parse not installed");
    const out = await parse(bytes);
    return out.text;
  } catch (e) {
    throw new Error(`PDF extraction unavailable (${(e as Error).message}). Ingest as text/markdown or a URL, or install pdf-parse.`);
  }
}

// --- Ingestion ----------------------------------------------------------------------------------
export async function ingestDocument(input: IngestInput): Promise<IngestResult> {
  const ownerId = input.scope === "global" ? null : input.ownerId;
  let text = input.text ?? "";
  let title = input.title ?? "";
  try {
    if (!text && input.url) { const ex = await extractFromUrl(input.url); text = ex.text; if (!title && ex.title) title = ex.title; }
    else if (!text && input.pdfBase64) { text = await extractPdf(Buffer.from(input.pdfBase64, "base64")); }
    text = text.trim();
    if (!text) return { docId: null, title: title || "(untitled)", chunks: 0, tokens: 0, status: "error", error: "no extractable text" };
    if (!title) title = input.url ?? text.slice(0, 60).replace(/\n/g, " ") + "…";

    const chunks = chunkText(text);
    if (!chunks.length) return { docId: null, title, chunks: 0, tokens: 0, status: "error", error: "no chunks produced" };

    const totalTokens = chunks.reduce((s, c) => s + c.tokenCount, 0);
    const doc = await db.query<{ id: string }>(
      `INSERT INTO agent_knowledge_doc (owner_id, title, author, source_url, kind, tags, chunk_count, token_count, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ingesting') RETURNING id`,
      [ownerId, title.slice(0, 300), input.author ?? null, input.url ?? null, input.kind ?? "article", input.tags ?? [], chunks.length, totalTokens],
    );
    const docId = Number(doc.rows[0].id);

    // Embed + insert each chunk (sequential to respect the metered gateway + keep ordering honest).
    let embModel = "";
    for (const c of chunks) {
      const { vector, model } = await llmGateway.embedText({ ownerId: input.ownerId, text: c.text, purpose: "embedding:knowledge" });
      embModel = model;
      await db.query(
        `INSERT INTO agent_knowledge_chunk (doc_id, owner_id, ordinal, heading_path, text, token_count, tags, embedding_model, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector)`,
        [docId, ownerId, c.ordinal, c.headingPath || null, c.text, c.tokenCount, input.tags ?? [], model, vecLiteral(vector)],
      );
    }
    await db.query(`UPDATE agent_knowledge_doc SET status='ready' WHERE id=$1`, [docId]);
    logger.info("knowledge ingested", { docId, title, chunks: chunks.length, embModel });
    return { docId, title, chunks: chunks.length, tokens: totalTokens, status: "ready" };
  } catch (e) {
    logger.warn("knowledge ingest failed", { message: (e as Error).message });
    return { docId: null, title: title || "(untitled)", chunks: 0, tokens: 0, status: "error", error: (e as Error).message };
  }
}

// List / forget — mirror the memory CRUD.
export async function listKnowledge(ownerId: number): Promise<Array<Record<string, unknown>>> {
  const r = await db.query(
    `SELECT id, owner_id IS NULL AS global, title, author, kind, tags, chunk_count, token_count, status, added_at
       FROM agent_knowledge_doc WHERE (owner_id=$1 OR owner_id IS NULL) AND deleted_at IS NULL
       ORDER BY added_at DESC LIMIT 100`, [ownerId]);
  return r.rows as Array<Record<string, unknown>>;
}

export async function forgetKnowledge(ownerId: number, docId: number): Promise<boolean> {
  const r = await db.query(
    `UPDATE agent_knowledge_doc SET deleted_at=now() WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL`, [docId, ownerId]);
  if (r.rowCount) await db.query(`UPDATE agent_knowledge_chunk SET deleted_at=now() WHERE doc_id=$1`, [docId]).catch(() => {});
  return Boolean(r.rowCount);
}

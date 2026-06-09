import { db } from "../db.js";
import { llmGateway } from "../llm-gateway/index.js";

// A2 — knowledge RETRIEVAL. Embeds the query, vector-searches the chunk corpus (owner + global shelf,
// same embedding_model only), and applies a light keyword boost (hybrid: dense leads, sparse breaks
// ties — the research-backed balance). Returns chunks with exact citations (doc title + heading_path)
// so the agent can quote sources. Advisory context only — never a numeric data source.

function vecLiteral(vec: number[]): string { return `[${vec.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`; }

export interface KnowledgeHit {
  docId: number; title: string; author: string | null; kind: string;
  headingPath: string | null; text: string; tags: string[];
  similarity: number; citation: string;
}

export async function retrieveKnowledge(
  ownerId: number, query: string, opts: { k?: number; tags?: string[] } = {},
): Promise<KnowledgeHit[]> {
  const k = Math.min(opts.k ?? 5, 12);
  if (!query.trim()) return [];
  const { vector, model } = await llmGateway.embedText({ ownerId, text: query, purpose: "embedding:knowledge_query" });
  const qv = vecLiteral(vector);

  // Pull a wider candidate set by vector distance, then re-rank with a keyword boost + tag filter.
  const tagFilter = opts.tags?.length ? `AND c.tags && $4` : "";
  const params: unknown[] = [ownerId, model, qv];
  if (opts.tags?.length) params.push(opts.tags);
  const rows = (await db.query(
    `SELECT c.doc_id, c.heading_path, c.text, c.tags, (c.embedding <=> $3::vector) AS distance,
            d.title, d.author, d.kind
       FROM agent_knowledge_chunk c JOIN agent_knowledge_doc d ON d.id = c.doc_id
      WHERE (c.owner_id = $1 OR c.owner_id IS NULL) AND c.deleted_at IS NULL AND d.deleted_at IS NULL
        AND c.embedding_model = $2 AND c.embedding IS NOT NULL ${tagFilter}
      ORDER BY c.embedding <=> $3::vector LIMIT 24`,
    params,
  )).rows as Array<Record<string, unknown>>;

  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
  const scored = rows.map((r) => {
    const dist = Number(r.distance ?? 1);
    const relevance = Math.max(0, 1 - dist);
    const text = String(r.text ?? "");
    const lc = text.toLowerCase();
    const kw = terms.length ? terms.filter((t) => lc.includes(t)).length / terms.length : 0;
    const score = relevance * 0.85 + kw * 0.15;
    const title = String(r.title ?? "");
    const heading = r.heading_path ? String(r.heading_path) : null;
    return {
      docId: Number(r.doc_id), title, author: r.author ? String(r.author) : null, kind: String(r.kind ?? "article"),
      headingPath: heading, text, tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      similarity: Number(relevance.toFixed(3)), citation: heading ? `${title} — ${heading}` : title,
      _score: score,
    };
  });
  scored.sort((a, b) => b._score - a._score);
  // MMR-lite: drop near-duplicate chunks from the same doc+heading.
  const seen = new Set<string>();
  const out: KnowledgeHit[] = [];
  for (const s of scored) {
    const key = `${s.docId}:${s.headingPath ?? ""}`;
    if (seen.has(key) && out.length >= 2) continue;
    seen.add(key);
    const { _score, ...hit } = s;
    void _score;
    out.push(hit);
    if (out.length >= k) break;
  }
  return out;
}

// Compact prompt block of retrieved knowledge with citations. "" when nothing relevant.
export function renderKnowledgeBlock(hits: KnowledgeHit[]): string {
  if (!hits.length) return "";
  const lines = hits.map((h) => `- [${h.citation}] ${h.text.slice(0, 360).replace(/\s+/g, " ").trim()}${h.text.length > 360 ? "…" : ""}`);
  return `Relevant trading knowledge (advisory context — cite by source, never as live data):\n${lines.join("\n")}`;
}

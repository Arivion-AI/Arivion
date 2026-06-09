// A2 — structure-aware CHUNKING for the knowledge RAG. Per the financial-RAG research, target 200–500
// token chunks with coherent topic boundaries: split on headings/blank lines, then pack paragraphs up
// to the target without crossing a heading. Each chunk carries its heading_path for exact citations.
// Pure + deterministic (no I/O) so it's unit-testable. Token count is estimated at ~4 chars/token.

export interface Chunk { ordinal: number; headingPath: string; text: string; tokenCount: number }

const TARGET_TOKENS = 350;
const MAX_TOKENS = 500;
const MIN_TOKENS = 60;
const estTokens = (s: string): number => Math.ceil(s.length / 4);

// Detect a heading line: markdown (#..), ALL-CAPS short lines, or "Chapter N" / "N. Title" patterns.
function headingOf(line: string): string | null {
  const t = line.trim();
  if (!t) return null;
  const md = t.match(/^#{1,6}\s+(.*)$/);
  if (md) return md[1].trim().slice(0, 80);
  if (/^(chapter|section|part)\s+[\dIVXLC]+/i.test(t) && t.length < 80) return t.slice(0, 80);
  if (/^\d+(\.\d+)*\.?\s+\S/.test(t) && t.length < 80) return t.slice(0, 80);
  if (t.length < 60 && t === t.toUpperCase() && /[A-Z]/.test(t) && !/[.!?]$/.test(t)) return t.slice(0, 80);
  return null;
}

export function chunkText(raw: string): Chunk[] {
  const text = raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return [];
  const lines = text.split("\n");

  // Group lines into (headingPath, paragraph[]) segments.
  const segments: Array<{ heading: string; body: string }> = [];
  let curHeading = "";
  let buf: string[] = [];
  const flush = () => { const body = buf.join("\n").trim(); if (body) segments.push({ heading: curHeading, body }); buf = []; };
  for (const line of lines) {
    const h = headingOf(line);
    if (h) { flush(); curHeading = h; } else { buf.push(line); }
  }
  flush();

  // Pack each segment's paragraphs into target-sized chunks (never crossing a heading boundary).
  const chunks: Chunk[] = [];
  let ordinal = 0;
  for (const seg of segments) {
    const paras = seg.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let cur = "";
    const push = () => {
      const t = cur.trim();
      if (t && estTokens(t) >= MIN_TOKENS) { chunks.push({ ordinal: ordinal++, headingPath: seg.heading, text: t, tokenCount: estTokens(t) }); cur = ""; }
      else if (t && chunks.length) { chunks[chunks.length - 1].text += "\n\n" + t; chunks[chunks.length - 1].tokenCount = estTokens(chunks[chunks.length - 1].text); cur = ""; } // merge a tiny tail
      else cur = "";
    };
    for (const p of paras) {
      // A single oversized paragraph → hard-split on sentences.
      if (estTokens(p) > MAX_TOKENS) {
        if (cur) push();
        for (const piece of splitLong(p)) { cur = piece; push(); }
        continue;
      }
      if (estTokens(cur + "\n\n" + p) > TARGET_TOKENS && cur) push();
      cur = cur ? cur + "\n\n" + p : p;
    }
    push();
  }
  return chunks;
}

function splitLong(p: string): string[] {
  const sentences = p.match(/[^.!?]+[.!?]+|\S+$/g) ?? [p];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (estTokens(cur + s) > TARGET_TOKENS && cur) { out.push(cur.trim()); cur = ""; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

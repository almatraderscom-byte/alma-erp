/**
 * Semantic long-term memory store (G06 / SPEC-055).
 *
 * A pgvector-style store: records carry a pre-computed embedding and search is
 * deterministic cosine similarity. Embeddings are INPUTS — generating them is a
 * provider call that goes through the Cost Governor elsewhere, so this module
 * makes NO model call and stays deterministic (INV-01). The durable pgvector
 * table is a documented seam (proposed migration); in-memory is the default.
 * Tenant-scoped (full privacy guard in SPEC-058).
 */
import { z } from 'zod';
import { executionIdentitySchema, type ExecutionIdentity } from '@/agent/contracts';

export interface MemoryRecord {
  id: string;
  identity: ExecutionIdentity;
  text: string;
  embedding: number[];
  atMs: number;
  tags: string[];
}

export const memoryRecordSchema: z.ZodType<MemoryRecord> = z.object({
  id: z.string().min(1),
  identity: executionIdentitySchema,
  text: z.string(),
  embedding: z.array(z.number()).min(1),
  atMs: z.number().int().nonnegative(),
  tags: z.array(z.string()),
}) as z.ZodType<MemoryRecord>;

export interface SearchHit {
  record: MemoryRecord;
  score: number; // cosine similarity, -1..1
}

/** Deterministic cosine similarity. Returns 0 for zero/mismatched vectors. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SemanticMemoryStore {
  add(record: MemoryRecord): void;
  search(tenantId: string, queryEmbedding: number[], k: number): SearchHit[];
  size(): number;
}

export class InMemorySemanticStore implements SemanticMemoryStore {
  private readonly records: MemoryRecord[] = [];

  add(record: MemoryRecord): void {
    const parsed = memoryRecordSchema.safeParse(record);
    if (!parsed.success) throw new Error(`invalid MemoryRecord: ${parsed.error.issues[0]?.message}`);
    this.records.push({ ...(parsed.data as MemoryRecord) });
  }

  search(tenantId: string, queryEmbedding: number[], k: number): SearchHit[] {
    return this.records
      .filter((r) => r.identity.tenantId === tenantId) // tenant isolation at query time
      .map((r) => ({ record: { ...r }, score: cosine(queryEmbedding, r.embedding) }))
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
      .slice(0, Math.max(0, k));
  }

  size(): number {
    return this.records.length;
  }
}

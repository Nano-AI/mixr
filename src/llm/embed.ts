import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { config } from '../config.ts';
import { fromVec, one, q, toVec } from '../db/index.ts';
import { trace } from '../trace.ts';
import { normalize } from '../vec.ts';

export type Embedder = (texts: string[]) => Promise<number[][]>;

const key = (text: string) => createHash('sha256').update(`${config.embeddingModel}:${config.dims}:${text}`).digest('hex');

// Real embeddings, cached in Postgres by text so unchanged text is never re-billed.
const openaiEmbed: Embedder = async (texts) => {
  const out: (number[] | null)[] = await Promise.all(
    texts.map(async (t) => fromVec((await one<{ e: string }>('SELECT embedding::text AS e FROM embedding_cache WHERE key = $1', [key(t)]))?.e ?? null)),
  );
  const missing = texts.map((t, i) => (out[i] ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const client = new OpenAI({ apiKey: config.openaiKey });
    const r = await client.embeddings.create({ model: config.embeddingModel, dimensions: config.dims, input: missing.map((i) => texts[i]) });
    for (const [j, i] of missing.entries()) {
      out[i] = r.data[j].embedding;
      await q('INSERT INTO embedding_cache (key, embedding) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key(texts[i]), toVec(out[i]!)]);
    }
    await trace('embed', null, { count: missing.length, cached: texts.length - missing.length, tokens: r.usage.total_tokens });
  }
  return out as number[][];
};

// Offline stand-in: hashed bag of words, so texts sharing words are similar and unrelated texts are near-orthogonal.
export const fakeEmbed: Embedder = async (texts) =>
  texts.map((t) => {
    const v = new Array(config.dims).fill(0);
    for (const raw of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const w = raw.length > 3 ? raw.replace(/s$/, '') : raw;
      const h = createHash('md5').update(w).digest();
      for (let k = 0; k < 4; k++) v[h.readUInt16LE(k * 2) % config.dims] += h[8 + k] & 1 ? 1 : -1;
    }
    return normalize(v);
  });

let current: Embedder = config.fake ? fakeEmbed : openaiEmbed;

export const embed: Embedder = (texts) => current(texts);
export const embedOne = async (text: string): Promise<number[]> => (await embed([text]))[0];
export const setEmbedder = (e: Embedder): void => void (current = e);

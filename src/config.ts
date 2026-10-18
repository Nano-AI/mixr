import { existsSync } from 'node:fs';

// Tests configure env through vitest.config.ts; everything else reads .env.
if (!process.env.VITEST && existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;

export const config = {
  openaiKey: env.OPENAI_API_KEY ?? '',
  llmModel: env.LLM_MODEL ?? 'gpt-6-luna',
  embeddingModel: env.EMBEDDING_MODEL ?? 'text-embedding-3-large',
  dims: Number(env.EMBEDDING_DIMS ?? 1536),
  // Offline fakes for the LLM and embeddings. Tests always run with this on.
  fake: env.MIXR_FAKE === '1',
  // When off, matching/profiles/events skip their LLM steps and use vector-only + template fallbacks.
  pipelineLlm: env.PIPELINE_LLM !== 'off',
  dbDir: env.DB_DIR ?? './data/mixr',
  port: Number(env.PORT ?? 8787),
};

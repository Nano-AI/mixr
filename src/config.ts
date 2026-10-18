import { existsSync } from 'node:fs';

// Tests configure env through vitest.config.ts; everything else reads .env.
if (!process.env.VITEST && existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;

export const config = {
  // Claude: the conversation agent and the matching pipeline (canonicalize, HyDE, rerank, evolve).
  anthropicKey: env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  anthropicWorkspace: env.ANTHROPIC_WORKSPACE_ID ?? '',
  // Hard cap on attempted Claude requests per UTC day, tool follow-ups included. Persisted, survives restarts.
  claudeDailyLimit: Number(env.CLAUDE_DAILY_REQUEST_LIMIT ?? 1000),
  // OpenAI is used for embeddings only.
  openaiKey: env.OPENAI_API_KEY ?? '',
  embeddingModel: env.EMBEDDING_MODEL ?? 'text-embedding-3-large',
  dims: Number(env.EMBEDDING_DIMS ?? 1536),
  // Offline fakes for the LLM and embeddings. Tests always run with this on.
  fake: env.MIXR_FAKE === '1',
  // When off, matching/profiles/events skip their LLM steps and use vector-only + template fallbacks.
  pipelineLlm: env.PIPELINE_LLM !== 'off',
  dbDir: env.DB_DIR ?? './data/mixr',
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '127.0.0.1',
  // Public base URL of this server; any hostname works (the server never checks Host).
  publicUrl: env.PUBLIC_URL ?? '',
  adminToken: env.ADMIN_TOKEN ?? '',
  production: env.NODE_ENV === 'production',
  // photon = real users' messages go out over iMessage; sim = nothing leaves the server.
  transport: env.TRANSPORT === 'photon' ? ('photon' as const) : ('sim' as const),
  photonProjectId: env.PROJECT_ID ?? '',
  photonProjectSecret: env.PROJECT_SECRET ?? '',
  joinOrigins: (env.JOIN_ORIGINS ?? 'https://joinmixr.club,https://www.joinmixr.club')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};

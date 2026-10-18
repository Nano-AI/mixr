import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { db } from './db/index.ts';

// Nightly snapshot of the whole database. PGlite's data directory can't be copied safely while it's open, so
// the running server dumps itself (a gzipped tarball PGlite can load back with `loadDataDir`).
// Restore: stop mixr, then start PGlite once with { loadDataDir: <file> } into an empty DB_DIR.

const KEEP = 7; // tune: daily snapshots kept

export const backupDir = (): string => process.env.BACKUP_DIR ?? join(config.dbDir, '..', 'backups');

export async function backupNow(): Promise<string | null> {
  if (config.dbDir.includes('://')) return null; // in-memory (tests): nothing to back up
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `mixr-${new Date().toISOString().slice(0, 10)}.tar.gz`);
  const blob = await (await db()).dumpDataDir('gzip');
  writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  const old = readdirSync(dir)
    .filter((f) => /^mixr-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(f))
    .sort()
    .slice(0, -KEEP);
  for (const f of old) rmSync(join(dir, f));
  return file;
}

// Once per UTC day, called from the ticker.
let lastDay = '';
export async function maybeBackup(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  if (day === lastDay) return;
  lastDay = day;
  try {
    const file = await backupNow();
    if (file) console.log(`backup written: ${file}`);
  } catch (e) {
    lastDay = ''; // try again next tick
    console.error('backup failed:', e instanceof Error ? e.message : e);
  }
}

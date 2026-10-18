// Safe copy of the database while the backend is running. Keeps the newest 14 copies.
//
//   node scripts/backup.js                 # writes to <DATA_DIR>/backups
//   docker compose exec -T backend node scripts/backup.js
//
// Photos and videos are plain files in <DATA_DIR>/media; copy that folder off the server too.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';

const KEEP = 14;
const { dataDir } = loadConfig();
const dir = path.join(dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const target = path.join(dir, `ipa-${stamp}.db`);
const db = new Database(path.join(dataDir, 'ipa.db'), { readonly: true, fileMustExist: true });
await db.backup(target);
db.close();
console.log(`Saved ${target}`);

const old = fs
  .readdirSync(dir)
  .filter((f) => /^ipa-.*\.db$/.test(f))
  .sort()
  .slice(0, -KEEP);
for (const f of old) fs.rmSync(path.join(dir, f));

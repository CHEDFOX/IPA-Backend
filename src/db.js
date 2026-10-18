import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

// Append new migrations to the end; never edit one that has shipped.
const MIGRATIONS = [
  `
  CREATE TABLE properties (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    share_token TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'land' CHECK (type IN ('land', 'residential', 'commercial')),
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'under_offer', 'sold')),
    visibility TEXT NOT NULL DEFAULT 'draft' CHECK (visibility IN ('public', 'unlisted', 'draft')),
    featured INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    price REAL,
    price_note TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    area REAL,
    area_unit TEXT NOT NULL DEFAULT 'm2',
    bedrooms INTEGER,
    bathrooms INTEGER,
    summary TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '[]',
    nearby TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE media (
    id INTEGER PRIMARY KEY,
    property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('gallery', 'plan', 'brochure', 'hero', 'portrait')),
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'document')),
    key TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    duration REAL,
    file TEXT,
    original TEXT,
    variants TEXT NOT NULL DEFAULT '{}',
    alt TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX media_by_property ON media (property_id, role, sort_order);

  CREATE TABLE enquiries (
    id INTEGER PRIMARY KEY,
    property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
    property_title TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    contact TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    page_url TEXT NOT NULL DEFAULT '',
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  `,
];

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'ipa.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

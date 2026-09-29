import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let db;

export function getDb(file) {
  if (db) return db;
  const target = file || path.join(config.dataDir, 'cdp.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

/** For tests: open a fresh isolated DB. */
export function openTestDb() {
  const d = new DatabaseSync(':memory:');
  d.exec('PRAGMA foreign_keys = ON;');
  migrate(d);
  return d;
}

export function migrate(d) {
  d.exec(`
  -- One row per unique person. A profile may come from the newsletter list,
  -- an app account, or an unknown webhook user_id.
  CREATE TABLE IF NOT EXISTS profiles (
    id               INTEGER PRIMARY KEY,
    email            TEXT UNIQUE,            -- normalized (trim + lowercase); NULL for app-only unknown users
    email_hash       TEXT,                   -- HMAC(PII_HASH_KEY, email) – safe pseudonym
    is_subscriber    INTEGER NOT NULL DEFAULT 0,
    signup_date      TEXT,                   -- YYYY-MM-DD
    status           TEXT,                   -- normalized lowercase: active | unsubscribed | bounced | ...
    source           TEXT,                   -- normalized lowercase acquisition source (instagram, facebook, organic, ...)
    last_open_date   TEXT,                   -- YYYY-MM-DD
    duplicate_count  INTEGER NOT NULL DEFAULT 0, -- how many extra raw rows were merged into this one
    origin           TEXT NOT NULL,          -- 'subscribers_csv' | 'app_users_csv' | 'webhook'
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS web_events (
    id           INTEGER PRIMARY KEY,
    visitor_id   TEXT,
    page         TEXT,
    ts           TEXT,                       -- ISO-8601 UTC
    utm_source   TEXT,                       -- normalized lowercase
    email        TEXT,                       -- normalized, as captured (nullable)
    profile_id   INTEGER REFERENCES profiles(id)
  );
  CREATE INDEX IF NOT EXISTS ix_web_profile ON web_events(profile_id);
  CREATE INDEX IF NOT EXISTS ix_web_visitor ON web_events(visitor_id);

  CREATE TABLE IF NOT EXISTS app_users (
    user_id      TEXT PRIMARY KEY,
    email        TEXT,                       -- normalized (nullable for unknown webhook users)
    created_date TEXT,
    profile_id   INTEGER NOT NULL REFERENCES profiles(id),
    origin       TEXT NOT NULL               -- 'app_users_csv' | 'webhook'
  );
  CREATE INDEX IF NOT EXISTS ix_app_users_profile ON app_users(profile_id);

  -- device -> user mapping learned from login events (identity stitching)
  CREATE TABLE IF NOT EXISTS devices (
    device_id    TEXT PRIMARY KEY,
    user_id      TEXT,
    first_seen   TEXT,
    linked_at    TEXT
  );

  -- Raw webhook events. event_id is the idempotency key.
  CREATE TABLE IF NOT EXISTS app_events (
    event_id     TEXT PRIMARY KEY,
    event        TEXT NOT NULL,              -- app_open | read_story | link_click | login
    user_id      TEXT,                       -- as sent (null before login)
    device_id    TEXT,
    ts           TEXT NOT NULL,              -- event time (ISO)
    properties   TEXT,                       -- JSON
    received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    resolved_user_id TEXT,                   -- user_id after device stitching
    profile_id   INTEGER REFERENCES profiles(id)
  );
  CREATE INDEX IF NOT EXISTS ix_app_events_profile ON app_events(profile_id);
  CREATE INDEX IF NOT EXISTS ix_app_events_device ON app_events(device_id);

  -- Record of every import (for data-quality reporting)
  CREATE TABLE IF NOT EXISTS imports (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL,              -- subscribers | web_events | app_users
    filename     TEXT,
    rows_in      INTEGER,
    rows_loaded  INTEGER,
    report       TEXT,                       -- JSON data-quality report (counts only, no PII)
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Exact log of everything sent to / received from the LLM (for the PII self-audit)
  CREATE TABLE IF NOT EXISTS llm_audit (
    id           INTEGER PRIMARY KEY,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    direction    TEXT NOT NULL,              -- 'to_model' | 'from_model'
    payload      TEXT NOT NULL,              -- JSON exactly as sent/received
    pii_findings INTEGER NOT NULL DEFAULT 0  -- result of the PII scanner on this payload
  );
  `);
}

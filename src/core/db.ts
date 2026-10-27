import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function defaultDbPath(): string {
  return process.env.PITFALL_HUB_DB || join(homedir(), '.pitfall-hub', 'pitfalls.db')
}

// Each entry migrates user_version from index to index + 1.
const MIGRATIONS = [
  `
  CREATE TABLE pitfalls (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    id              TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL,
    symptom         TEXT NOT NULL DEFAULT '',
    cause           TEXT NOT NULL DEFAULT '',
    solution        TEXT NOT NULL,
    prevention      TEXT NOT NULL DEFAULT '',
    tags            TEXT NOT NULL DEFAULT '[]',
    environment     TEXT NOT NULL DEFAULT '',
    error_signature TEXT NOT NULL DEFAULT '',
    source_project  TEXT NOT NULL DEFAULT '',
    source_agent    TEXT NOT NULL DEFAULT '',
    severity        TEXT NOT NULL DEFAULT 'medium',
    status          TEXT NOT NULL DEFAULT 'active',
    hit_count       INTEGER NOT NULL DEFAULT 0,
    helpful_count   INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    last_hit_at     TEXT
  );
  CREATE INDEX pitfalls_status ON pitfalls(status);

  CREATE VIRTUAL TABLE pitfalls_fts USING fts5(
    title, symptom, cause, solution, prevention, tags, error_signature, environment,
    content='pitfalls', content_rowid='seq', tokenize='trigram'
  );

  CREATE TRIGGER pitfalls_ai AFTER INSERT ON pitfalls BEGIN
    INSERT INTO pitfalls_fts(rowid, title, symptom, cause, solution, prevention, tags, error_signature, environment)
    VALUES (new.seq, new.title, new.symptom, new.cause, new.solution, new.prevention, new.tags, new.error_signature, new.environment);
  END;
  CREATE TRIGGER pitfalls_ad AFTER DELETE ON pitfalls BEGIN
    INSERT INTO pitfalls_fts(pitfalls_fts, rowid, title, symptom, cause, solution, prevention, tags, error_signature, environment)
    VALUES ('delete', old.seq, old.title, old.symptom, old.cause, old.solution, old.prevention, old.tags, old.error_signature, old.environment);
  END;
  CREATE TRIGGER pitfalls_au AFTER UPDATE OF title, symptom, cause, solution, prevention, tags, error_signature, environment ON pitfalls BEGIN
    INSERT INTO pitfalls_fts(pitfalls_fts, rowid, title, symptom, cause, solution, prevention, tags, error_signature, environment)
    VALUES ('delete', old.seq, old.title, old.symptom, old.cause, old.solution, old.prevention, old.tags, old.error_signature, old.environment);
    INSERT INTO pitfalls_fts(rowid, title, symptom, cause, solution, prevention, tags, error_signature, environment)
    VALUES (new.seq, new.title, new.symptom, new.cause, new.solution, new.prevention, new.tags, new.error_signature, new.environment);
  END;
  `,
  // Agents' reports about the platform itself (false positives, misses, bugs, ideas).
  `
  CREATE TABLE feedback (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    id             TEXT NOT NULL UNIQUE,
    kind           TEXT NOT NULL,
    title          TEXT NOT NULL,
    detail         TEXT NOT NULL DEFAULT '',
    pitfall_id     TEXT,
    source_project TEXT NOT NULL DEFAULT '',
    source_agent   TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'open',
    votes          INTEGER NOT NULL DEFAULT 1,
    resolution     TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX feedback_status ON feedback(status);
  `,
]

export function openDatabase(path = defaultDbPath()): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  migrate(db)
  return db
}

function migrate(db: DatabaseSync) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v]!)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

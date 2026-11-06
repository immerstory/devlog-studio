import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globalFromStudio } from "./project-model.js";
import type { StudioConfig } from "./config.js";

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set; run `npm run setup`.");
    pool = new pg.Pool({ connectionString: url, max: 8 });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query<T>(sql, params)).rows;
}

/** Runs fn in a transaction; rows locked with FOR UPDATE stay locked until it returns. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/**
 * The schema of a new database. Each entity keeps its full JSON in `data`; the other columns exist for ordering and
 * filtering and are written from the same object on every save.
 */
const BASELINE = `
  CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL);
  CREATE TABLE projects (id text PRIMARY KEY, slug text UNIQUE NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
  CREATE TABLE suggestions (
    id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), work_date date NOT NULL, publish_date date,
    status text NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
  CREATE INDEX suggestions_work_date ON suggestions (work_date);
  CREATE INDEX suggestions_project_id ON suggestions (project_id);
  CREATE TABLE notes (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), date date NOT NULL, created_at timestamptz NOT NULL, text text NOT NULL);
  CREATE INDEX notes_project_id ON notes (project_id);
  CREATE TABLE materials (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), date date NOT NULL, created_at timestamptz NOT NULL, data jsonb NOT NULL);
  CREATE INDEX materials_date ON materials (date);
  CREATE INDEX materials_project_id ON materials (project_id);
  CREATE TABLE posts (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), created_at timestamptz NOT NULL, data jsonb NOT NULL);
  CREATE INDEX posts_project_id ON posts (project_id);
  CREATE TABLE runs (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), kind text NOT NULL, created_at timestamptz NOT NULL, evidence jsonb, output jsonb);
  CREATE INDEX runs_project_id ON runs (project_id);
  CREATE TABLE video_stats (
    video_id text NOT NULL, fetched_at timestamptz NOT NULL,
    views bigint NOT NULL, likes bigint NOT NULL, comments bigint NOT NULL,
    PRIMARY KEY (video_id, fetched_at));
  CREATE TABLE activity (project_id text NOT NULL REFERENCES projects(id), id text NOT NULL, date text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (project_id, id));
  CREATE INDEX activity_project_date ON activity (project_id, date);
  CREATE TABLE activity_links (project_id text NOT NULL REFERENCES projects(id), a text NOT NULL, b text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (project_id, a, b));
  CREATE TABLE publications (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), post_id text NOT NULL, data jsonb NOT NULL);
  CREATE INDEX publications_post ON publications (project_id, post_id);
  CREATE TABLE publication_stats (
    publication_id text NOT NULL, project_id text NOT NULL REFERENCES projects(id), fetched_at timestamptz NOT NULL, metrics jsonb NOT NULL,
    PRIMARY KEY (publication_id, fetched_at));
  CREATE TABLE egress_connections (id text PRIMARY KEY, connector text NOT NULL, data jsonb NOT NULL);
`;

/** Brings the database up to date. Every schema change adds one `applyMigration` call with the next version number. */
export async function migrate() {
  await query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL)");
  await applyMigration(1, async (c) => {
    await c.query(BASELINE);
    const example = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../config/studio.example.json"), "utf8")) as StudioConfig;
    await c.query("INSERT INTO settings (key, value) VALUES ('global', $1)", [globalFromStudio(example)]);
  });
}

export async function applyMigration(version: number, work: (c: pg.PoolClient) => Promise<void>) {
  await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(4777000)");
    if ((await c.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version])).rowCount) return;
    await work(c);
    await c.query("INSERT INTO schema_migrations VALUES ($1, now())", [version]);
  });
}

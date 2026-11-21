import pg from 'pg';
import type { PGlite } from '@electric-sql/pglite';
import { PG_MIGRATIONS } from './migrations.ts';

const MIGRATION_LOCK_KEY = 84209173;

export interface SqlQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface SqlRunner {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<SqlQueryResult<T>>;
  exec(sql: string): Promise<void>;
}

export interface SqlExecutor extends SqlRunner {
  withTransaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T>;
  withRetry<T>(fn: () => Promise<T>, label?: string): Promise<T>;
  ping(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export function sanitizeSecretString(message: string): string {
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED_JWT]');
}

function isRetryablePgError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  const code = e.code ?? '';
  if (
    [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EAI_AGAIN',
      'ENOTFOUND',
      'EPIPE',
      '57P01',
      '57P02',
      '57P03',
      '08000',
      '08001',
      '08003',
      '08004',
      '08006',
      'XX000',
    ].includes(code)
  ) {
    return true;
  }
  const msg = (e.message ?? '').toLowerCase();
  return (
    msg.includes('connection terminated') ||
    msg.includes('timeout exceeded') ||
    msg.includes('connect timeout') ||
    msg.includes('endpoint is disabled') ||
    msg.includes('could not connect') ||
    msg.includes('server closed the connection unexpectedly')
  );
}

export async function withExponentialRetry<T>(
  fn: () => Promise<T>,
  options?: { maxTotalMs?: number; initialDelayMs?: number; label?: string },
): Promise<T> {
  const maxTotalMs = options?.maxTotalMs ?? 30_000;
  const initialDelayMs = options?.initialDelayMs ?? 500;
  const startedAt = Date.now();
  let attempt = 0;
  let delayMs = initialDelayMs;

  while (true) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      const elapsed = Date.now() - startedAt;
      if (!isRetryablePgError(err) || elapsed + delayMs > maxTotalMs) {
        throw err;
      }
      const label = options?.label ? ` (${options.label})` : '';
      const safeMsg = err instanceof Error ? sanitizeSecretString(err.message) : 'Error transitorio';
      console.warn(
        `[PostgreSQL] Reintento ${attempt}${label} en ${delayMs}ms tras fallo de conexión: ${safeMsg}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 5_000);
    }
  }
}

export function createPgPoolExecutor(connectionString: string): SqlExecutor {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });

  pool.on('error', (err) => {
    console.error('[PostgreSQL Pool]', sanitizeSecretString(err.message));
  });

  let firstQuerySucceeded = false;

  const runRawQuery = async <T extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<SqlQueryResult<T>> => {
    const res = await pool.query<T>(sql, params);
    firstQuerySucceeded = true;
    return {
      rows: res.rows,
      rowCount: res.rowCount ?? res.rows.length,
    };
  };

  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<SqlQueryResult<T>> {
      if (!firstQuerySucceeded) {
        return withExponentialRetry(() => runRawQuery<T>(sql, params), {
          maxTotalMs: 30_000,
          label: 'primera consulta',
        });
      }
      return runRawQuery<T>(sql, params);
    },

    async exec(sql: string): Promise<void> {
      const execute = async () => {
        await pool.query(sql);
        firstQuerySucceeded = true;
      };
      if (!firstQuerySucceeded) {
        await withExponentialRetry(execute, { maxTotalMs: 30_000, label: 'exec inicial' });
        return;
      }
      await execute();
    },

    async withTransaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
      const client = await withExponentialRetry(() => pool.connect(), {
        maxTotalMs: 30_000,
        label: 'pool.connect',
      });
      const runner: SqlRunner = {
        async query<R extends Record<string, unknown> = Record<string, unknown>>(
          sql: string,
          params: unknown[] = [],
        ) {
          const res = await client.query<R>(sql, params);
          firstQuerySucceeded = true;
          return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
        },
        async exec(sql: string) {
          await client.query(sql);
          firstQuerySucceeded = true;
        },
      };

      try {
        await client.query('BEGIN');
        const result = await fn(runner);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    withRetry<T>(fn: () => Promise<T>, label?: string): Promise<T> {
      return withExponentialRetry(fn, { maxTotalMs: 30_000, label });
    },

    async ping(timeoutMs: number = 2_500): Promise<boolean> {
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const check = pool.query('SELECT 1 AS ok').then(() => true);
        const timeout = new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        });
        return await Promise.race([check, timeout]);
      } catch {
        return false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export function createPgliteExecutor(db: PGlite): SqlExecutor {
  let txQueue: Promise<unknown> = Promise.resolve();

  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = txQueue.then(fn, fn);
    txQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const runner: SqlRunner = {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<SqlQueryResult<T>> {
      const res = await db.query<T>(sql, params);
      return {
        rows: res.rows,
        rowCount: res.affectedRows ?? res.rows.length,
      };
    },

    async exec(sql: string): Promise<void> {
      await db.exec(sql);
    },
  };

  return {
    query: runner.query,
    exec: runner.exec,

    withTransaction<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
      return serialize(async () => {
        await db.exec('BEGIN');
        try {
          const out = await fn(runner);
          await db.exec('COMMIT');
          return out;
        } catch (err) {
          await db.exec('ROLLBACK').catch(() => {});
          throw err;
        }
      });
    },

    withRetry<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },

    async ping(): Promise<boolean> {
      try {
        await db.query('SELECT 1 AS ok');
        return true;
      } catch {
        return false;
      }
    },

    async close(): Promise<void> {
      await db.close();
    },
  };
}

export async function runMigrationsWithAdvisoryLock(
  executor: SqlExecutor,
  unpooledConnectionString?: string,
): Promise<void> {
  if (unpooledConnectionString && unpooledConnectionString.trim().length > 0) {
    const migrationClient = new pg.Client({
      connectionString: unpooledConnectionString.trim(),
      connectionTimeoutMillis: 10_000,
    });
    migrationClient.on('error', (err) => {
      console.error('[PostgreSQL Migrations]', sanitizeSecretString(err.message));
    });
    await withExponentialRetry(() => migrationClient.connect(), {
      maxTotalMs: 30_000,
      label: 'migraciones unpooled connect',
    });

    const runner: SqlRunner = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ) {
        const res = await migrationClient.query<T>(sql, params);
        return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
      },
      async exec(sql: string) {
        await migrationClient.query(sql);
      },
    };

    try {
      await applyMigrationsOnRunner(runner);
    } finally {
      await migrationClient.end().catch(() => {});
    }
    return;
  }

  await executor.withRetry(async () => {
    await applyMigrationsOnRunner(executor);
  }, 'migraciones');
}

async function applyMigrationsOnRunner(runner: SqlRunner): Promise<void> {
  let locked = false;
  try {
    await runner.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    locked = true;
  } catch {
    // Algunos entornos locales embebidos podrían no exponer pg_advisory_lock; continuamos de forma idempotente
    locked = false;
  }

  try {
    await runner.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL
      );
    `);

    const appliedRes = await runner.query<{ id: string }>('SELECT id FROM schema_migrations');
    const applied = new Set(appliedRes.rows.map((r) => r.id));

    for (const migration of PG_MIGRATIONS) {
      if (applied.has(migration.id)) continue;

      await runner.exec('BEGIN');
      try {
        await runner.exec(migration.sql);
        await runner.query(
          'INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
          [migration.id, new Date().toISOString()],
        );
        await runner.exec('COMMIT');
      } catch (err) {
        await runner.exec('ROLLBACK').catch(() => {});
        throw err;
      }
    }
  } finally {
    if (locked) {
      await runner.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    }
  }
}

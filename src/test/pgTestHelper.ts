import { PGlite } from '@electric-sql/pglite';
import {
  createPgPoolExecutor,
  createPgliteExecutor,
  type SqlExecutor,
} from '../server/pgConnection.ts';
import { PgClockRepository } from '../server/pgRepository.ts';
import type { InitAndSeedOptions } from '../server/repository.ts';

export async function createTestPgRepo(
  options: InitAndSeedOptions = { seedDemoData: true, demoMustChangePassword: false },
): Promise<PgClockRepository> {
  const testDbUrl = process.env.TEST_DATABASE_URL?.trim();
  let executor: SqlExecutor;

  if (testDbUrl) {
    executor = createPgPoolExecutor(testDbUrl);
    await executor.exec(`
      DROP TABLE IF EXISTS mita_simulated_corrections CASCADE;
      DROP TABLE IF EXISTS session_incidents CASCADE;
      DROP TABLE IF EXISTS day_offs CASCADE;
      DROP TABLE IF EXISTS planned_shifts CASCADE;
      DROP TABLE IF EXISTS shift_templates CASCADE;
      DROP TABLE IF EXISTS clock_policies CASCADE;
      DROP TABLE IF EXISTS mita_outbox CASCADE;
      DROP TABLE IF EXISTS audit_log CASCADE;
      DROP TABLE IF EXISTS work_sessions CASCADE;
      DROP TABLE IF EXISTS corrections CASCADE;
      DROP TABLE IF EXISTS sync_acknowledgements CASCADE;
      DROP TABLE IF EXISTS clock_events CASCADE;
      DROP TABLE IF EXISTS break_types CASCADE;
      DROP TABLE IF EXISTS employees CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TABLE IF EXISTS schema_migrations CASCADE;
    `);
  } else {
    const db = new PGlite();
    executor = createPgliteExecutor(db);
  }

  const repo = new PgClockRepository({ executor });
  await repo.initAndSeed(options);
  return repo;
}

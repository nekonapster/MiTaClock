import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import {
  createPgPoolExecutor,
  createPgliteExecutor,
  sanitizeSecretString,
  type SqlExecutor,
} from './pgConnection.ts';
import { PgClockRepository } from './pgRepository.ts';

dotenv.config();

async function main() {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() || 'admin@mitaclock.es').toLowerCase();
  const password =
    process.env.BOOTSTRAP_ADMIN_PASSWORD?.trim() ||
    process.env.SEED_DEMO_PASSWORD?.trim() ||
    'MiTaDemo2026!';
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Elena Morales (Admin)';

  const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';
  let executor: SqlExecutor;
  let storageLabel: string;

  if (databaseUrl.length > 0) {
    executor = createPgPoolExecutor(databaseUrl);
    storageLabel = 'PostgreSQL (DATABASE_URL)';
  } else {
    const devDbDir = path.resolve(process.cwd(), 'data', 'pglite-dev');
    fs.mkdirSync(devDbDir, { recursive: true });
    const { PGlite } = await import('@electric-sql/pglite');
    executor = createPgliteExecutor(new PGlite(devDbDir));
    storageLabel = `PGlite local (${devDbDir})`;
  }

  const repo = new PgClockRepository({
    executor,
    unpooledConnectionString: process.env.DATABASE_URL_UNPOOLED?.trim() || undefined,
  });

  try {
    await repo.initAndSeed({
      seedDemoData: process.env.SEED_DEMO_DATA?.trim().toLowerCase() !== 'false',
      seedDemoPassword: password,
      demoMustChangePassword: false,
      repairDemoAccounts: true,
      bootstrapAdmin: {
        email,
        password,
        name,
        resetPasswordIfExists: true,
      },
    });
    console.log(`[MiTa Clock] Administrador garantizado en ${storageLabel}: ${email}`);
  } finally {
    await repo.close();
  }
}

main().catch((err) => {
  const safeMsg = err instanceof Error ? sanitizeSecretString(err.message) : 'Error desconocido';
  console.error('[MiTa Clock] Error al restaurar administrador:', safeMsg);
  process.exit(1);
});

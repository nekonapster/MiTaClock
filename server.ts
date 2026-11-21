import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import { createApp } from './src/server/app.ts';
import { resolveJwtSecret } from './src/server/auth.ts';
import { FakeMitaGateway, SimulatedMitaGateway, type MitaGateway } from './src/server/mitaGateway.ts';
import {
  createPgPoolExecutor,
  createPgliteExecutor,
  sanitizeSecretString,
  type SqlExecutor,
} from './src/server/pgConnection.ts';
import { PgClockRepository } from './src/server/pgRepository.ts';
import {
  createWatchdogCoordinator,
  startSessionWatchdogTimer,
} from './src/server/watchdog.ts';

dotenv.config();

async function createExecutor(): Promise<{ executor: SqlExecutor; mode: 'postgres' | 'pglite-dev' }> {
  const isProd = process.env.NODE_ENV === 'production';
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';

  if (databaseUrl.length > 0) {
    return {
      executor: createPgPoolExecutor(databaseUrl),
      mode: 'postgres',
    };
  }

  if (isProd) {
    throw new Error(
      'DATABASE_URL es obligatoria en producción (cadena de conexión PostgreSQL de Neon con sslmode=require).',
    );
  }

  // En desarrollo local sin DATABASE_URL, usamos PGlite persistente para permitir pruebas locales inmediatas
  const devDbDir = path.resolve(process.cwd(), 'data', 'pglite-dev');
  fs.mkdirSync(devDbDir, { recursive: true });
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite(devDbDir);
  console.warn(
    `[Desarrollo] DATABASE_URL no está definida. Usando PGlite local en ${devDbDir}. Configura DATABASE_URL para conectar con PostgreSQL/Neon.`,
  );
  return {
    executor: createPgliteExecutor(pglite),
    mode: 'pglite-dev',
  };
}

function resolveServerJwtSecret(isProd: boolean): string {
  if (isProd || (process.env.JWT_SECRET?.trim() ?? '').length > 0) {
    return resolveJwtSecret();
  }
  const dataDir = path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const secretFile = path.join(dataDir, '.jwt-dev-secret');
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch {
    // file does not exist yet
  }
  const generated = resolveJwtSecret();
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  const port = Number(process.env.PORT || 3000);
  const mitaMode = (process.env.MITA_MODE?.trim() || 'fake').toLowerCase();

  // Validar JWT_SECRET antes de abrir conexiones para fallar rápido en producción si falta o es débil
  const jwtSecret = resolveServerJwtSecret(isProd);

  const { executor, mode } = await createExecutor();
  const unpooledConnectionString = process.env.DATABASE_URL_UNPOOLED?.trim() || undefined;
  const repo = new PgClockRepository({
    executor,
    unpooledConnectionString,
  });

  const seedDemoData =
    process.env.SEED_DEMO_DATA !== undefined
      ? process.env.SEED_DEMO_DATA.trim().toLowerCase() === 'true'
      : !isProd;

  const allowDemoAuth = process.env.ALLOW_DEMO_AUTH
    ? process.env.ALLOW_DEMO_AUTH.trim().toLowerCase() === 'true'
    : !isProd || seedDemoData;

  const seedDemoPassword =
    process.env.SEED_DEMO_PASSWORD?.trim() || (!isProd && allowDemoAuth ? 'MiTaDemo2026!' : '');

  const demoMustChangePassword =
    process.env.DEMO_MUST_CHANGE_PASSWORD !== undefined
      ? process.env.DEMO_MUST_CHANGE_PASSWORD.trim().toLowerCase() === 'true'
      : isProd;

  await repo.initAndSeed({
    seedDemoData,
    seedDemoPassword,
    demoMustChangePassword,
    repairDemoAccounts: !isProd && allowDemoAuth,
  });

  const gateway: MitaGateway =
    mitaMode === 'fake'
      ? new SimulatedMitaGateway(repo.getExecutor(), (filter) => repo.listPlannedShifts(filter))
      : new FakeMitaGateway((filter) => repo.listPlannedShifts(filter));

  const app = createApp(repo, {
    jwtSecret,
    mitaGateway: gateway,
    allowDemoAuth,
    demoPasswordHint: !isProd && allowDemoAuth && seedDemoPassword ? seedDemoPassword : undefined,
  });

  // Nota: En Render (plan gratuito), el servicio entra en suspensión tras inactividad.
  // El watchdog es idempotente: se ejecuta al arrancar, periódicamente cada 5 min y al
  // consultar endpoints críticos para recuperar huecos tras reactivarse.
  const startupWatchdog = createWatchdogCoordinator({ repo, gateway, minIntervalMs: 30_000 });
  startupWatchdog.runNow(true).catch((err) => {
    const safeMsg = err instanceof Error ? sanitizeSecretString(err.message) : 'Error desconocido';
    console.error('[Watchdog] Error en verificación inicial:', safeMsg);
  });
  const watchdogTimer = startSessionWatchdogTimer(() => startupWatchdog.runNow(false), 5 * 60 * 1000);

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (!fs.existsSync(distDir)) {
      throw new Error('No se encontró la carpeta compilada dist/. Ejecuta npm run build primero.');
    }
    app.use(
      express.static(distDir, {
        index: false,
        maxAge: '1h',
        setHeaders(res, filePath) {
          if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest') || filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/health') {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server: http.Server = app.listen(port, '0.0.0.0', () => {
    console.log(`MiTa Clock activo en http://0.0.0.0:${port} (BD: ${mode}, MiTa: ${mitaMode})`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[MiTa Clock] Señal ${signal} recibida. Cerrando servidor de forma ordenada...`);
    clearInterval(watchdogTimer);

    const forceTimer = setTimeout(() => {
      console.error('[MiTa Clock] Tiempo de espera agotado al cerrar conexiones; saliendo.');
      process.exit(1);
    }, 10_000);
    if (typeof forceTimer.unref === 'function') {
      forceTimer.unref();
    }

    server.close(async () => {
      try {
        await repo.close();
      } catch (err) {
        const safeMsg = err instanceof Error ? sanitizeSecretString(err.message) : 'Error al cerrar BD';
        console.error('[MiTa Clock] Error cerrando pool PostgreSQL:', safeMsg);
      } finally {
        clearTimeout(forceTimer);
        process.exit(0);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((err) => {
  const safeMsg = err instanceof Error ? sanitizeSecretString(err.message) : 'Error desconocido';
  console.error('Error al iniciar MiTa Clock:', safeMsg);
  process.exit(1);
});

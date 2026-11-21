import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { resolveJwtSecret } from '../server/auth';
import type { PgClockRepository } from '../server/pgRepository';
import { createTestPgRepo } from './pgTestHelper';

describe('API REST MiTa Clock — Auth, RBAC, Fichajes y Sincronización MiTa v2.0', () => {
  let repo: PgClockRepository;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    repo = await createTestPgRepo({ seedDemoData: true, demoMustChangePassword: false });
    app = createApp(repo, {
      jwtSecret: 'test-secret-key-for-vitest-only-32chars',
      allowDemoAuth: true,
      mitaSyncKey: 'test-mita-sync-key',
      maxLoginAttempts: 3,
      loginWindowMs: 60_000,
    });
  });

  afterEach(async () => {
    await repo.close();
  });

  it('bloquea intentos repetidos de login (respetando X-Forwarded-For) y permite cierre de sesión', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', '203.0.113.10')
        .set('X-Requested-With', 'MiTaClock')
        .send({ email: 'lucia@mitaclock.es', password: 'incorrecta' });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '203.0.113.10')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email: 'lucia@mitaclock.es', password: 'incorrecta' });
    expect(blocked.status).toBe(429);

    // Otra IP real detrás del proxy de Render no queda bloqueada por el límite de la primera IP
    const otherIpAttempt = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.77')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email: 'lucia@mitaclock.es', password: 'incorrecta' });
    expect(otherIpAttempt.status).toBe(401);

    // Otra cuenta puede iniciar sesión vía demo-login y cerrar sesión
    const demo = await request(app)
      .post('/api/v1/auth/demo-login')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email: 'carlos@mitaclock.es' });
    expect(demo.status).toBe(200);
    const cookies = demo.headers['set-cookie'];
    expect(cookies).toBeDefined();

    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookies);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('carlos@mitaclock.es');

    const logout = await request(app)
      .post('/api/v1/auth/logout')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', cookies);
    expect(logout.status).toBe(200);
  });

  it('aplica RBAC estricto: el empleado solo ve sus eventos y no accede a admin', async () => {
    const empLogin = await request(app)
      .post('/api/v1/auth/demo-login')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email: 'lucia@mitaclock.es' });
    const empCookie = empLogin.headers['set-cookie'];

    const adminLogin = await request(app)
      .post('/api/v1/auth/demo-login')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email: 'admin@mitaclock.es' });
    const adminCookie = adminLogin.headers['set-cookie'];

    // Empleado intenta acceder al panel admin -> 403
    const forbiddenAdmin = await request(app)
      .get('/api/v1/admin/overview')
      .set('Cookie', empCookie);
    expect(forbiddenAdmin.status).toBe(403);

    // Empleado ficha inicio de jornada
    const startRes = await request(app)
      .post('/api/v1/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', empCookie)
      .send({
        id: '33333333-3333-4333-8333-333333333333',
        type: 'shift_start',
        deviceDeclaredAt: new Date().toISOString(),
        deviceOffsetMs: 0,
      });
    expect(startRes.status).toBe(201);

    // Otro empleado no puede ver los fichajes de Lucía
    const carlosLogin = await request(app)
      .post('/api/v1/auth/demo-login')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email: 'carlos@mitaclock.es' });
    const carlosEvents = await request(app)
      .get('/api/v1/clock-events')
      .set('Cookie', carlosLogin.headers['set-cookie']);
    expect(carlosEvents.status).toBe(200);
    expect(carlosEvents.body.events).toHaveLength(0);

    // Admin sí ve la actividad del equipo
    const overview = await request(app)
      .get('/api/v1/admin/overview')
      .set('Cookie', adminCookie);
    expect(overview.status).toBe(200);
    const luciaRow = overview.body.employees.find(
      (e: { email: string }) => e.email === 'lucia@mitaclock.es',
    );
    expect(luciaRow.workState).toBe('en_jornada');
  });

  it('cierra automáticamente una pausa abierta al confirmar shift_end y soporta sincronización MiTa v2.0', async () => {
    const empLogin = await request(app)
      .post('/api/v1/auth/demo-login')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email: 'sofia@mitaclock.es' });
    const empCookie = empLogin.headers['set-cookie'];

    const t1 = '2026-11-21T08:00:00.000Z';
    const t2 = '2026-11-21T10:00:00.000Z';
    const t3 = '2026-11-21T12:00:00.000Z';

    const batchRes = await request(app)
      .post('/api/v1/clock-events/batch')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', empCookie)
      .send({
        events: [
          {
            id: '44444444-4444-4444-8444-444444444441',
            type: 'shift_start',
            deviceDeclaredAt: t1,
            deviceOffsetMs: 0,
            offline: true,
          },
          {
            id: '44444444-4444-4444-8444-444444444442',
            type: 'break_start',
            deviceDeclaredAt: t2,
            deviceOffsetMs: 0,
            offline: true,
          },
        ],
      });
    expect(batchRes.status).toBe(200);
    expect(batchRes.body.results[0].event.timeSource).toBe('device_declared');

    // Finalizar mientras está en pausa con closeActiveBreakId
    const endRes = await request(app)
      .post('/api/v1/clock-events/batch')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', empCookie)
      .send({
        events: [
          {
            id: '44444444-4444-4444-8444-444444444443',
            type: 'break_end',
            deviceDeclaredAt: t3,
            deviceOffsetMs: 0,
          },
          {
            id: '44444444-4444-4444-8444-444444444444',
            type: 'shift_end',
            deviceDeclaredAt: t3,
            deviceOffsetMs: 0,
          },
        ],
      });
    expect(endRes.status).toBe(200);

    // MiTa v2.0 extrae eventos pendientes de confirmación y los confirma
    const pullRes = await request(app)
      .get('/api/v1/mita/events?status=enviado')
      .set('X-MiTa-Api-Key', 'test-mita-sync-key');
    expect(pullRes.status).toBe(200);
    expect(pullRes.body.events.length).toBe(4);

    const ids = pullRes.body.events.map((e: { event_id: string }) => e.event_id);
    const confirmRes = await request(app)
      .post('/api/v1/mita/confirm')
      .set('X-MiTa-Api-Key', 'test-mita-sync-key')
      .send({ event_ids: ids, mita_ack_ref: 'LARAVEL-BATCH-99' });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.confirmedCount).toBe(4);

    const afterPull = await request(app)
      .get('/api/v1/mita/events?status=enviado')
      .set('X-MiTa-Api-Key', 'test-mita-sync-key');
    expect(afterPull.body.events).toHaveLength(0);
  });

  it('permite al admin crear un empleado con contraseña bcrypt y entrar por login estándar', async () => {
    const adminLogin = await request(app)
      .post('/api/v1/auth/demo-login')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email: 'admin@mitaclock.es' });
    const adminCookie = adminLogin.headers['set-cookie'];

    const createRes = await request(app)
      .post('/api/v1/admin/employees')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', adminCookie)
      .send({
        name: 'Marta Gómez',
        email: 'marta@mitaclock.es',
        password: 'clave-segura-test',
        role: 'employee',
        externalRef: 'MITA-EMP-200',
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.employee.externalRef).toBe('MITA-EMP-200');

    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email: 'marta@mitaclock.es', password: 'clave-segura-test' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.employeeName).toBe('Marta Gómez');
  });

  it('expone /health verificando PostgreSQL (200 ok / 503 si cae BD)', async () => {
    const okRes = await request(app).get('/health');
    expect(okRes.status).toBe(200);
    expect(okRes.body.ok).toBe(true);
    expect(okRes.body.db).toBe('up');

    const degradedRepo = Object.assign(Object.create(Object.getPrototypeOf(repo)), repo, {
      ping: async () => false,
    });
    const degradedApp = createApp(degradedRepo, {
      jwtSecret: 'test-secret-key-for-vitest-only-32chars',
    });
    const downRes = await request(degradedApp).get('/health');
    expect(downRes.status).toBe(503);
    expect(downRes.body.ok).toBe(false);
    expect(downRes.body.db).toBe('down');
  });

  it('exige JWT_SECRET fuerte en NODE_ENV=production', () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevSecret = process.env.JWT_SECRET;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.JWT_SECRET;
      expect(() => resolveJwtSecret()).toThrow(/JWT_SECRET/);

      process.env.JWT_SECRET = 'corta-o-changeme';
      expect(() => resolveJwtSecret()).toThrow(/JWT_SECRET/);

      process.env.JWT_SECRET = '9f2c7b1e4a8d3f609c5a2b7e1d4f8a3c6b9e2d5a7c0f1e4b8a6d3c9f2e5a1b4d';
      expect(resolveJwtSecret()).toBe(process.env.JWT_SECRET);
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = prevSecret;
    }
  });
});

describe('Seguridad primer inicio — Cambio obligatorio de contraseña en usuarios demo', () => {
  let repo: PgClockRepository;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    repo = await createTestPgRepo({ seedDemoData: true, demoMustChangePassword: true });
    app = createApp(repo, {
      jwtSecret: 'test-secret-first-login-32characters',
      allowDemoAuth: true,
    });
  });

  afterEach(async () => {
    await repo.close();
  });

  it('bloquea rutas operativas hasta cambiar la contraseña inicial y después permite fichar e iniciar con ella', async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/demo-login')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email: 'lucia@mitaclock.es' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.mustChangePassword).toBe(true);
    const cookie = loginRes.headers['set-cookie'];

    const blockedClock = await request(app)
      .post('/api/v1/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', cookie)
      .send({
        id: '99999999-9999-4999-8999-999999999991',
        type: 'shift_start',
        deviceDeclaredAt: new Date().toISOString(),
        deviceOffsetMs: 0,
      });
    expect(blockedClock.status).toBe(403);
    expect(blockedClock.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changeRes = await request(app)
      .post('/api/v1/auth/change-password')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', cookie)
      .send({ newPassword: 'NuevaClaveSegura2026!' });
    expect(changeRes.status).toBe(200);
    expect(changeRes.body.user.mustChangePassword).toBe(false);

    const allowedClock = await request(app)
      .post('/api/v1/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', changeRes.headers['set-cookie'])
      .send({
        id: '99999999-9999-4999-8999-999999999992',
        type: 'shift_start',
        deviceDeclaredAt: new Date().toISOString(),
        deviceOffsetMs: 0,
      });
    expect(allowedClock.status).toBe(201);

    const stdLogin = await request(app)
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email: 'lucia@mitaclock.es', password: 'NuevaClaveSegura2026!' });
    expect(stdLogin.status).toBe(200);
    expect(stdLogin.body.user.mustChangePassword).toBe(false);
  });
});

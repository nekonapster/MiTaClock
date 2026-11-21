import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { FakeMitaGateway } from '../server/mitaGateway';
import type { PgClockRepository } from '../server/pgRepository';
import { createTestPgRepo } from './pgTestHelper';

describe('Módulo de Corrección de Fichajes — TDD (12 invariantes obligatorias)', () => {
  let repo: PgClockRepository;
  let gateway: FakeMitaGateway;
  let app: ReturnType<typeof createApp>;

  const nowRef = new Date('2026-11-21T12:00:00.000Z');

  beforeEach(async () => {
    repo = await createTestPgRepo({ seedDemoData: true, demoMustChangePassword: false });
    gateway = new FakeMitaGateway();
    app = createApp(repo, {
      jwtSecret: 'test-secret-corrections-vitest-32c',
      allowDemoAuth: true,
      mitaSyncKey: 'test-mita-sync-key',
      mitaGateway: gateway,
      correctionLookbackDays: 7,
      anomalyConfig: {
        lateEndOverHours: 2,
        scheduleToleranceMinutes: 30,
        maxOpenHours: 12,
        maxShiftMinutes: 14 * 60,
      },
      nowProvider: () => nowRef,
    });
  });

  afterEach(async () => {
    await repo.close();
  });

  async function loginAs(email: string) {
    const res = await request(app)
      .post('/api/auth/demo-login')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email });
    expect(res.status).toBe(200);
    return {
      cookie: res.headers['set-cookie'] as unknown as string[],
      user: res.body.user as { id: string; employeeId: string; email: string; role: string },
    };
  }

  async function seedEvent(
    cookie: string[],
    id: string,
    type: 'shift_start' | 'shift_end' | 'break_start' | 'break_end',
    utcIso: string,
  ) {
    const res = await request(app)
      .post('/api/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', cookie)
      .send({
        id,
        type,
        deviceDeclaredAt: utcIso,
        deviceOffsetMs: 60 * 60 * 1000,
        offline: true,
      });
    expect([200, 201]).toContain(res.status);
    return res.body.event;
  }

  it('1. Anular un evento no lo borra ni lo modifica: sigue en la tabla y la jornada se recalcula sin él', async () => {
    const lucia = await loginAs('lucia@mitaclock.es');
    const admin = await loginAs('admin@mitaclock.es');

    // Fichaje accidental fuera de horario ayer
    const strayId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    await seedEvent(lucia.cookie, strayId, 'shift_start', '2026-11-20T05:30:00.000Z');

    const reqRes = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-void-1')
      .set('Cookie', lucia.cookie)
      .send({
        targetEventId: strayId,
        kind: 'void_event',
        reason: 'Pulsé Iniciar jornada por error desde el bolsillo antes de entrar',
      });
    expect(reqRes.status).toBe(201);

    const approveRes = await request(app)
      .post(`/api/v1/clock/corrections/${reqRes.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({ resolutionNote: 'Anulación confirmada' });
    expect(approveRes.status).toBe(200);

    // El evento original SIGUE en clock_events y además existe el compensatorio source=admin
    const eventsRes = await request(app)
      .get(`/api/clock-events?employeeId=${lucia.user.employeeId}`)
      .set('Cookie', admin.cookie);
    expect(eventsRes.status).toBe(200);
    const original = eventsRes.body.events.find((e: { id: string }) => e.id === strayId);
    const voidEv = eventsRes.body.events.find(
      (e: { type: string; correctsEventId: string }) =>
        e.type === 'event_void' && e.correctsEventId === strayId,
    );
    expect(original).toBeDefined();
    expect(original.type).toBe('shift_start');
    expect(voidEv).toBeDefined();
    expect(voidEv.source).toBe('admin');

    // Las sesiones recalculadas ya no muestran una jornada abierta errónea
    const sessionsRes = await request(app)
      .get('/api/v1/clock/sessions')
      .set('Cookie', lucia.cookie);
    expect(sessionsRes.status).toBe(200);
    const activeSessions = sessionsRes.body.sessions.filter(
      (s: { status: string }) => s.status !== 'voided',
    );
    expect(activeSessions).toHaveLength(0);
  });

  it('2. Cambiar la hora de una salida de 18:00 a 14:00 recalcula el tiempo trabajado y deja ambos eventos visibles', async () => {
    const lucia = await loginAs('lucia@mitaclock.es');
    const admin = await loginAs('admin@mitaclock.es');

    // En Madrid (CET = UTC+1): 08:00 Madrid = 07:00 UTC, 18:00 Madrid = 17:00 UTC, 14:00 Madrid = 13:00 UTC
    const startId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
    const endId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
    await seedEvent(lucia.cookie, startId, 'shift_start', '2026-11-20T07:00:00.000Z');
    await seedEvent(lucia.cookie, endId, 'shift_end', '2026-11-20T17:00:00.000Z');

    const corrRes = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-change-1')
      .set('Cookie', lucia.cookie)
      .send({
        targetEventId: endId,
        kind: 'change_time',
        reason: 'Olvidé fichar la salida a las 14:00 y fiché al llegar a casa a las 18:00',
        proposedChange: {
          declaredAtUtc: '2026-11-20T13:00:00.000Z',
        },
      });
    expect(corrRes.status).toBe(201);
    expect(corrRes.body.preview.beforeWorkedMinutes).toBe(600); // 10h
    expect(corrRes.body.preview.afterWorkedMinutes).toBe(360); // 6h

    const approveRes = await request(app)
      .post(`/api/v1/clock/corrections/${corrRes.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({});
    expect(approveRes.status).toBe(200);

    // Verificar ambos eventos visibles en la tabla (original 18:00, anulador y nuevo 14:00 source=admin)
    const eventsRes = await request(app)
      .get('/api/clock-events')
      .set('Cookie', lucia.cookie);
    expect(eventsRes.body.events.some((e: { id: string }) => e.id === endId)).toBe(true);
    const replacement = eventsRes.body.events.find(
      (e: { source: string; type: string; correctsEventId: string }) =>
        e.source === 'admin' && e.type === 'shift_end' && e.correctsEventId === endId,
    );
    expect(replacement).toBeDefined();
    expect(replacement.deviceDeclaredAt).toBe('2026-11-20T13:00:00.000Z');
    expect(replacement.timeSource).toBe('device_declared');

    // La sesión proyectada tiene 360 worked_minutes (6h)
    const sessionsRes = await request(app)
      .get('/api/v1/clock/sessions')
      .set('Cookie', lucia.cookie);
    expect(sessionsRes.body.sessions[0].workedMinutes).toBe(360);
    expect(sessionsRes.body.sessions[0].hasApprovedCorrection).toBe(true);
  });

  it('3. Añadir un evento olvidado completa una jornada incompleta', async () => {
    const carlos = await loginAs('carlos@mitaclock.es');
    const admin = await loginAs('admin@mitaclock.es');

    // Carlos fichó entrada ayer a las 08:00 Madrid (07:00 UTC) pero olvidó fichar la salida de las 14:00 Madrid (13:00 UTC)
    await seedEvent(carlos.cookie, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'shift_start', '2026-11-20T07:00:00.000Z');

    const corrRes = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-add-1')
      .set('Cookie', carlos.cookie)
      .send({
        targetEventId: null,
        kind: 'add_event',
        reason: 'Salí del turno a las 14:00 al terminar la clase y no fiché salida',
        proposedChange: {
          eventType: 'shift_end',
          declaredAtUtc: '2026-11-20T13:00:00.000Z',
        },
      });
    expect(corrRes.status).toBe(201);

    const approveRes = await request(app)
      .post(`/api/v1/clock/corrections/${corrRes.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({});
    expect(approveRes.status).toBe(200);

    const sessionsRes = await request(app)
      .get('/api/v1/clock/sessions')
      .set('Cookie', carlos.cookie);
    expect(sessionsRes.body.sessions).toHaveLength(1);
    expect(sessionsRes.body.sessions[0].status).toBe('closed');
    expect(sessionsRes.body.sessions[0].workedMinutes).toBe(360);
  });

  it('4. Un empleado no puede solicitar ni ver correcciones de otro empleado', async () => {
    const lucia = await loginAs('lucia@mitaclock.es');
    const carlos = await loginAs('carlos@mitaclock.es');

    const luciaEvId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
    await seedEvent(lucia.cookie, luciaEvId, 'shift_start', '2026-11-20T07:00:00.000Z');

    // Carlos intenta pedir corrección sobre el evento de Lucía -> 403
    const hijackAttempt = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-hijack-1')
      .set('Cookie', carlos.cookie)
      .send({
        targetEventId: luciaEvId,
        kind: 'void_event',
        reason: 'Intento acceder a un fichaje que pertenece a otra compañera',
      });
    expect(hijackAttempt.status).toBe(403);
    expect(hijackAttempt.headers['content-type']).toContain('application/problem+json');

    // Lucía crea su corrección
    const luciaCorr = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-lucia-own')
      .set('Cookie', lucia.cookie)
      .send({
        targetEventId: luciaEvId,
        kind: 'void_event',
        reason: 'Anular inicio erróneo registrado antes de entrar a pista',
      });
    expect(luciaCorr.status).toBe(201);

    // Carlos no la ve en su listado ni puede leerla por ID
    const listCarlos = await request(app)
      .get('/api/v1/clock/corrections')
      .set('Cookie', carlos.cookie);
    expect(listCarlos.body.corrections).toHaveLength(0);

    const getByIdCarlos = await request(app)
      .get(`/api/v1/clock/corrections/${luciaCorr.body.correction.id}`)
      .set('Cookie', carlos.cookie);
    expect(getByIdCarlos.status).toBe(403);
  });

  it('5. Un administrador no puede aprobar su propia solicitud (debe hacerlo otro admin)', async () => {
    const admin1 = await loginAs('admin@mitaclock.es');

    // Crear un segundo administrador
    const createAdmin2 = await request(app)
      .post('/api/admin/employees')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin1.cookie)
      .send({
        name: 'Laura Admin 2',
        email: 'admin2@mitaclock.es',
        password: 'clave-admin-2-segura',
        role: 'admin',
        externalRef: 'MITA-ADM-002',
      });
    expect(createAdmin2.status).toBe(201);

    // Admin 1 ficha una entrada y pide corrección para sí mismo
    const evId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
    await seedEvent(admin1.cookie, evId, 'shift_start', '2026-11-20T08:00:00.000Z');

    const selfCorr = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-self-admin')
      .set('Cookie', admin1.cookie)
      .send({
        targetEventId: evId,
        kind: 'change_time',
        reason: 'Llegué a las 08:30 y fiché un poco más tarde al encender el ordenador',
        proposedChange: { declaredAtUtc: '2026-11-20T07:30:00.000Z' },
      });
    expect(selfCorr.status).toBe(201);

    // Admin 1 intenta aprobar su propia solicitud -> 403
    const selfApprove = await request(app)
      .post(`/api/v1/clock/corrections/${selfCorr.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin1.cookie)
      .send({});
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.headers['content-type']).toContain('application/problem+json');

    // Admin 2 sí puede aprobarla
    const loginAdmin2 = await request(app)
      .post('/api/auth/login')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email: 'admin2@mitaclock.es', password: 'clave-admin-2-segura' });
    expect(loginAdmin2.status).toBe(200);

    const peerApprove = await request(app)
      .post(`/api/v1/clock/corrections/${selfCorr.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', loginAdmin2.headers['set-cookie'])
      .send({});
    expect(peerApprove.status).toBe(200);
  });

  it('6. Una solicitud que dejaría la secuencia incoherente se rechaza con 409 o 422', async () => {
    const sofia = await loginAs('sofia@mitaclock.es');

    const startId = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
    const endId = 'ffffffff-ffff-4fff-8fff-fffffffffff2';
    await seedEvent(sofia.cookie, startId, 'shift_start', '2026-11-20T08:00:00.000Z');
    await seedEvent(sofia.cookie, endId, 'shift_end', '2026-11-20T14:00:00.000Z');

    // Fin de jornada antes del inicio (07:00 < 08:00) -> 409/422
    const invalidOrder = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-incoherent-1')
      .set('Cookie', sofia.cookie)
      .send({
        targetEventId: endId,
        kind: 'change_time',
        reason: 'Intento poner la hora de salida antes de la hora de entrada',
        proposedChange: { declaredAtUtc: '2026-11-20T07:00:00.000Z' },
      });
    expect([409, 422]).toContain(invalidOrder.status);
    expect(invalidOrder.headers['content-type']).toContain('application/problem+json');

    // Hora propuesta en el futuro -> 422
    const futureAttempt = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-future-1')
      .set('Cookie', sofia.cookie)
      .send({
        targetEventId: null,
        kind: 'add_event',
        reason: 'Intento añadir un fichaje con fecha futura de mañana',
        proposedChange: {
          eventType: 'shift_start',
          declaredAtUtc: '2026-11-22T08:00:00.000Z',
        },
      });
    expect(futureAttempt.status).toBe(422);
  });

  it('7. Plazo máximo: una solicitud más antigua que el límite (7 días) se rechaza', async () => {
    const lucia = await loginAs('lucia@mitaclock.es');

    // Hace 10 días (fuera del límite de 7 días respecto a nowRef = 2026-11-21)
    const tooOldAttempt = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-too-old')
      .set('Cookie', lucia.cookie)
      .send({
        targetEventId: null,
        kind: 'add_event',
        reason: 'Olvidé fichar hace diez días la entrada de la mañana',
        proposedChange: {
          eventType: 'shift_start',
          declaredAtUtc: '2026-11-10T08:00:00.000Z',
        },
      });
    expect(tooOldAttempt.status).toBe(422);
    expect(tooOldAttempt.headers['content-type']).toContain('application/problem+json');
  });

  it('8. Rechazar exige nota; cancelar solo funciona en estado pending y por el autor', async () => {
    const lucia = await loginAs('lucia@mitaclock.es');
    const carlos = await loginAs('carlos@mitaclock.es');
    const admin = await loginAs('admin@mitaclock.es');

    const evId = '12121212-1212-4121-8121-121212121212';
    await seedEvent(lucia.cookie, evId, 'shift_start', '2026-11-20T08:00:00.000Z');

    const corr1 = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-cancel-1')
      .set('Cookie', lucia.cookie)
      .send({
        targetEventId: evId,
        kind: 'void_event',
        reason: 'Solicitud para probar cancelación por autor y por terceros',
      });
    expect(corr1.status).toBe(201);

    // Carlos no puede cancelar la solicitud de Lucía -> 403
    const otherCancel = await request(app)
      .post(`/api/v1/clock/corrections/${corr1.body.correction.id}/cancel`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', carlos.cookie)
      .send({});
    expect(otherCancel.status).toBe(403);

    // Rechazar sin nota -> 422
    const rejectNoNote = await request(app)
      .post(`/api/v1/clock/corrections/${corr1.body.correction.id}/reject`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({ resolutionNote: '   ' });
    expect(rejectNoNote.status).toBe(422);

    // Lucía la cancela -> 200
    const selfCancel = await request(app)
      .post(`/api/v1/clock/corrections/${corr1.body.correction.id}/cancel`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', lucia.cookie)
      .send({});
    expect(selfCancel.status).toBe(200);
    expect(selfCancel.body.correction.status).toBe('cancelled');

    // Cancelar de nuevo ya resuelta -> 409
    const doubleCancel = await request(app)
      .post(`/api/v1/clock/corrections/${corr1.body.correction.id}/cancel`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', lucia.cookie)
      .send({});
    expect(doubleCancel.status).toBe(409);
  });

  it('9. Aprobar dos veces la misma corrección no duplica eventos (idempotencia)', async () => {
    const lucia = await loginAs('lucia@mitaclock.es');
    const admin = await loginAs('admin@mitaclock.es');

    const evId = '13131313-1313-4131-8131-131313131313';
    await seedEvent(lucia.cookie, evId, 'shift_start', '2026-11-20T08:00:00.000Z');

    const corr = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-idem-create')
      .set('Cookie', lucia.cookie)
      .send({
        targetEventId: evId,
        kind: 'change_time',
        reason: 'Entré a las 08:30 reales pero fiché a las 09:00 por fallo de red',
        proposedChange: { declaredAtUtc: '2026-11-20T07:30:00.000Z' },
      });
    expect(corr.status).toBe(201);

    const firstApprove = await request(app)
      .post(`/api/v1/clock/corrections/${corr.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'approve-idem-key-1')
      .set('Cookie', admin.cookie)
      .send({});
    expect(firstApprove.status).toBe(200);

    // Segunda aprobación con misma Idempotency-Key o sin ella nunca duplica eventos
    const retryApprove = await request(app)
      .post(`/api/v1/clock/corrections/${corr.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'approve-idem-key-1')
      .set('Cookie', admin.cookie)
      .send({});
    expect([200, 409]).toContain(retryApprove.status);

    const secondApproveDifferentKey = await request(app)
      .post(`/api/v1/clock/corrections/${corr.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({});
    expect(secondApproveDifferentKey.status).toBe(409);

    const eventsRes = await request(app)
      .get('/api/clock-events')
      .set('Cookie', lucia.cookie);
    // Exactamente 3 eventos: original, anulador y nuevo
    expect(eventsRes.body.events).toHaveLength(3);
    expect(gateway.recordedCorrections).toHaveLength(1);
  });

  it('10. Las anomalías se detectan: fin 4 horas tras lo planificado y jornada abierta 12+ horas sin autocierre', async () => {
    const lucia = await loginAs('lucia@mitaclock.es');
    const carlos = await loginAs('carlos@mitaclock.es');

    // Planificado ejemplo para Lucía el 2026-11-20: 08:00-14:00 Madrid (07:00-13:00 UTC)
    // Lucía ficha salida 4 horas después: 18:00 Madrid (17:00 UTC)
    await seedEvent(lucia.cookie, '14141414-1414-4141-8141-141414141411', 'shift_start', '2026-11-20T07:00:00.000Z');
    await seedEvent(lucia.cookie, '14141414-1414-4141-8141-141414141412', 'shift_end', '2026-11-20T17:00:00.000Z');

    const luciaSessions = await request(app)
      .get('/api/v1/clock/sessions')
      .set('Cookie', lucia.cookie);
    expect(luciaSessions.status).toBe(200);
    expect(luciaSessions.body.sessions[0].anomalyFlags).toContain('late_end_over_n_hours');
    expect(luciaSessions.body.sessions[0].workedMinutes).toBe(600);
    expect(luciaSessions.body.sessions[0].plannedMinutes).toBe(360);
    expect(luciaSessions.body.sessions[0].deltaMinutes).toBe(240);

    // Carlos dejó abierta su jornada hace más de 12 horas (2026-11-20T07:00Z -> nowRef 2026-11-21T12:00Z = 29h)
    await seedEvent(carlos.cookie, '15151515-1515-4151-8151-151515151511', 'shift_start', '2026-11-20T07:00:00.000Z');
    const carlosSessions = await request(app)
      .get('/api/v1/clock/sessions')
      .set('Cookie', carlos.cookie);
    expect(carlosSessions.body.sessions[0].status).toBe('incomplete');
    expect(carlosSessions.body.sessions[0].endUtc).toBeNull();
    expect(carlosSessions.body.sessions[0].anomalyFlags).toContain('open_over_m_hours');
  });

  it('11. Solo las correcciones aprobadas entran en el outbox y se entregan a FakeMitaGateway sin duplicados', async () => {
    const lucia = await loginAs('lucia@mitaclock.es');
    const admin = await loginAs('admin@mitaclock.es');

    const startId = '16161616-1616-4161-8161-161616161611';
    const endId = '16161616-1616-4161-8161-161616161612';
    await seedEvent(lucia.cookie, startId, 'shift_start', '2026-11-20T07:00:00.000Z');
    await seedEvent(lucia.cookie, endId, 'shift_end', '2026-11-20T17:00:00.000Z');

    // Solicitud pendiente -> NO debe entrar en outbox
    const pendingCorr = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-outbox-pending')
      .set('Cookie', lucia.cookie)
      .send({
        targetEventId: endId,
        kind: 'change_time',
        reason: 'Salida real a las 14:00 pero pendiente de aprobar',
        proposedChange: { declaredAtUtc: '2026-11-20T13:00:00.000Z' },
      });
    expect(pendingCorr.status).toBe(201);
    expect(gateway.recordedCorrections).toHaveLength(0);

    // Solicitud rechazada -> NO debe entrar en outbox
    const rejectedCorr = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-outbox-rejected')
      .set('Cookie', lucia.cookie)
      .send({
        targetEventId: startId,
        kind: 'change_time',
        reason: 'Cambio erróneo de entrada que será rechazado por admin',
        proposedChange: { declaredAtUtc: '2026-11-20T06:30:00.000Z' },
      });
    expect(rejectedCorr.status).toBe(201);

    await request(app)
      .post(`/api/v1/clock/corrections/${rejectedCorr.body.correction.id}/reject`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({ resolutionNote: 'El turno comenzó a las 08:00 según cuadrante' });
    expect(gateway.recordedCorrections).toHaveLength(0);

    // Simular fallo temporal de red en el primer envío al gateway para probar reintento idempotente
    gateway.failNextAttempts = 1;
    const approveRes = await request(app)
      .post(`/api/v1/clock/corrections/${pendingCorr.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({ resolutionNote: 'Aprobado cambio de salida' });
    expect(approveRes.status).toBe(200);
    expect(gateway.recordedCorrections).toHaveLength(0); // quedó pendiente de reintento en outbox

    // Procesar outbox -> se entrega una sola vez con todos los datos requeridos
    const flushRes = await request(app)
      .post('/api/v1/admin/outbox/process')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({});
    expect(flushRes.status).toBe(200);
    expect(gateway.recordedCorrections).toHaveLength(1);
    const delivered = gateway.recordedCorrections[0];
    expect(delivered.sessionId).toBe(startId);
    expect(delivered.originalEvent?.id).toBe(endId);
    expect(delivered.correctionKind).toBe('change_time');
    expect(delivered.approvedBy.email).toBe('admin@mitaclock.es');
    expect(delivered.approvedAtUtc).toBeTruthy();

    // Reprocesar no duplica
    await request(app)
      .post('/api/v1/admin/outbox/process')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({});
    expect(gateway.recordedCorrections).toHaveLength(1);
  });

  it('12. Una corrección registra la entrada correspondiente en audit_log (quién, qué, cuándo, IP y agente)', async () => {
    const lucia = await loginAs('lucia@mitaclock.es');
    const admin = await loginAs('admin@mitaclock.es');

    const evId = '17171717-1717-4171-8171-171717171717';
    await seedEvent(lucia.cookie, evId, 'shift_start', '2026-11-20T07:00:00.000Z');

    const corr = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('User-Agent', 'MiTaTestAgent/1.0')
      .set('Idempotency-Key', 'corr-audit-1')
      .set('Cookie', lucia.cookie)
      .send({
        targetEventId: evId,
        kind: 'void_event',
        reason: 'Prueba de trazabilidad en audit_log al crear y aprobar',
      });
    expect(corr.status).toBe(201);

    await request(app)
      .post(`/api/v1/clock/corrections/${corr.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('User-Agent', 'AdminBrowser/2.0')
      .set('Cookie', admin.cookie)
      .send({});

    const auditRes = await request(app)
      .get('/api/v1/admin/audit-log')
      .set('Cookie', admin.cookie);
    expect(auditRes.status).toBe(200);

    const actions = auditRes.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain('correction.requested');
    expect(actions).toContain('correction.approved');

    const approvedEntry = auditRes.body.entries.find(
      (e: { action: string }) => e.action === 'correction.approved',
    );
    expect(approvedEntry.actorUserId).toBe(admin.user.id);
    expect(approvedEntry.userAgent).toBe('AdminBrowser/2.0');
    expect(approvedEntry.ipAddress).toBeTruthy();
    expect(approvedEntry.createdAt).toBeTruthy();
  });

  it('13. Anular jornada completa (void_day): una única petición anula todos los eventos del día al aprobarse', async () => {
    const lucia = await loginAs('lucia@mitaclock.es');
    const admin = await loginAs('admin@mitaclock.es');

    // Día 2026-11-20 con 4 registros: entrada, inicio pausa, fin pausa y salida
    const e1 = '18181818-1818-4181-8181-181818181811';
    const e2 = '18181818-1818-4181-8181-181818181812';
    const e3 = '18181818-1818-4181-8181-181818181813';
    const e4 = '18181818-1818-4181-8181-181818181814';
    await seedEvent(lucia.cookie, e1, 'shift_start', '2026-11-20T07:00:00.000Z');
    await seedEvent(lucia.cookie, e2, 'break_start', '2026-11-20T09:00:00.000Z');
    await seedEvent(lucia.cookie, e3, 'break_end', '2026-11-20T09:30:00.000Z');
    await seedEvent(lucia.cookie, e4, 'shift_end', '2026-11-20T13:00:00.000Z');

    // Solicitud única de anulación de jornada completa
    const reqRes = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-void-day-1')
      .set('Cookie', lucia.cookie)
      .send({
        targetEventId: null,
        kind: 'void_day',
        reason: 'Estuve de libranza el 20 de noviembre y fiché toda la jornada en el día equivocado',
        proposedChange: { madridDateKey: '2026-11-20' },
      });
    expect(reqRes.status).toBe(201);
    expect(reqRes.body.correction.kind).toBe('void_day');
    expect(reqRes.body.correction.targetEventId).toBeNull();
    expect(reqRes.body.correction.proposedChange.voidedEventIds).toEqual([e1, e2, e3, e4]);
    expect(reqRes.body.preview.madridDateKey).toBe('2026-11-20');
    expect(reqRes.body.preview.beforeWorkedMinutes).toBe(330);
    expect(reqRes.body.preview.afterWorkedMinutes).toBe(0);

    // Segundo intento pendiente para el mismo día -> 409
    const dupRes = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-void-day-dup')
      .set('Cookie', lucia.cookie)
      .send({
        targetEventId: null,
        kind: 'void_day',
        reason: 'Intento duplicado de anular la misma jornada completa',
        proposedChange: { madridDateKey: '2026-11-20' },
      });
    expect(dupRes.status).toBe(409);

    // Admin aprueba la única petición
    const approveRes = await request(app)
      .post(`/api/v1/clock/corrections/${reqRes.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({ resolutionNote: 'Jornada anulada al completo' });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.compensatingEvents).toHaveLength(4);
    for (const comp of approveRes.body.compensatingEvents) {
      expect(comp.type).toBe('event_void');
      expect(comp.source).toBe('admin');
      expect(comp.correctionId).toBe(reqRes.body.correction.id);
    }

    // Los 4 eventos originales siguen intactos en clock_events + 4 event_void
    const eventsRes = await request(app)
      .get('/api/clock-events')
      .set('Cookie', lucia.cookie);
    expect(eventsRes.body.events).toHaveLength(8);
    expect([e1, e2, e3, e4].every((id) => eventsRes.body.events.some((e: { id: string }) => e.id === id))).toBe(true);

    // Sesión proyectada queda anulada (sin sesiones activas)
    const sessionsRes = await request(app)
      .get('/api/v1/clock/sessions')
      .set('Cookie', lucia.cookie);
    const active = sessionsRes.body.sessions.filter((s: { status: string }) => s.status !== 'voided');
    expect(active).toHaveLength(0);

    // Outbox entregó una única corrección con los 4 eventos compensatorios
    expect(gateway.recordedCorrections).toHaveLength(1);
    expect(gateway.recordedCorrections[0].correctionKind).toBe('void_day');
    expect(gateway.recordedCorrections[0].compensatingEvents).toHaveLength(4);
  });

  it('14. Un administrador puede solicitar anular la jornada completa de un empleado y otro administrador la aprueba', async () => {
    const carlos = await loginAs('carlos@mitaclock.es');
    const admin1 = await loginAs('admin@mitaclock.es');

    await request(app)
      .post('/api/admin/employees')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin1.cookie)
      .send({
        name: 'Admin Revisor',
        email: 'admin3@mitaclock.es',
        password: 'clave-admin-3-segura',
        role: 'admin',
        externalRef: 'MITA-ADM-003',
      });

    const loginAdmin3 = await request(app)
      .post('/api/auth/login')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email: 'admin3@mitaclock.es', password: 'clave-admin-3-segura' });
    expect(loginAdmin3.status).toBe(200);

    await seedEvent(carlos.cookie, '19191919-1919-4191-8191-191919191911', 'shift_start', '2026-11-20T08:00:00.000Z');
    await seedEvent(carlos.cookie, '19191919-1919-4191-8191-191919191912', 'shift_end', '2026-11-20T12:00:00.000Z');

    const adminCreate = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'corr-admin-void-day')
      .set('Cookie', admin1.cookie)
      .send({
        employeeId: carlos.user.employeeId,
        targetEventId: null,
        kind: 'void_day',
        reason: 'Turno de prueba registrado en producción por error administrativo',
        proposedChange: { madridDateKey: '2026-11-20' },
      });
    expect(adminCreate.status).toBe(201);
    expect(adminCreate.body.correction.employeeId).toBe(carlos.user.employeeId);
    expect(adminCreate.body.correction.proposedChange.voidedEventIds).toHaveLength(2);

    // Admin1 no puede aprobar su propia solicitud -> 403
    const selfApprove = await request(app)
      .post(`/api/v1/clock/corrections/${adminCreate.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin1.cookie)
      .send({});
    expect(selfApprove.status).toBe(403);

    // Admin3 sí la aprueba -> anula los 2 registros
    const peerApprove = await request(app)
      .post(`/api/v1/clock/corrections/${adminCreate.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', loginAdmin3.headers['set-cookie'])
      .send({ resolutionNote: 'Validado entre administradores' });
    expect(peerApprove.status).toBe(200);
    expect(peerApprove.body.compensatingEvents).toHaveLength(2);
  });
});

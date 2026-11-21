import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../server/app';
import { FakeMitaGateway } from '../server/mitaGateway';
import type { PgClockRepository } from '../server/pgRepository';
import { createTestPgRepo } from './pgTestHelper';

describe('Planificación de Jornadas y Vigilancia de Relojes — TDD (13 pruebas obligatorias)', () => {
  let repo: PgClockRepository;
  let gateway: FakeMitaGateway;
  let app: ReturnType<typeof createApp>;
  let currentNow = new Date('2026-11-23T09:00:00.000Z'); // Lunes 2026-11-23

  beforeEach(async () => {
    currentNow = new Date('2026-11-23T09:00:00.000Z');
    repo = await createTestPgRepo({ seedDemoData: true, demoMustChangePassword: false });
    gateway = new FakeMitaGateway();
    app = createApp(repo, {
      jwtSecret: 'test-secret-planning-vitest-32ch',
      allowDemoAuth: true,
      mitaSyncKey: 'test-mita-sync-key',
      mitaGateway: gateway,
      nowProvider: () => currentNow,
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

  async function createEmployeeWithNoShifts(adminCookie: string[], email: string, name: string) {
    const res = await request(app)
      .post('/api/admin/employees')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', adminCookie)
      .send({
        name,
        email,
        password: 'password-segura-123',
        role: 'employee',
        externalRef: `MITA-${name.slice(0, 4).toUpperCase()}`,
      });
    expect(res.status).toBe(201);
    const login = await request(app)
      .post('/api/auth/login')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email, password: 'password-segura-123' });
    expect(login.status).toBe(200);
    return {
      employee: res.body.employee as { id: string; name: string; email: string },
      cookie: login.headers['set-cookie'] as unknown as string[],
      user: login.body.user as { id: string; employeeId: string; email: string; role: string },
    };
  }

  it('1. Generar jornadas desde plantilla L-V 08:00-15:00 crea 5 jornadas por semana de 420 minutos sin duplicar', async () => {
    const admin = await loginAs('admin@mitaclock.es');
    const emp = await createEmployeeWithNoShifts(admin.cookie, 'nuria@mitaclock.es', 'Nuria Torres');

    // Crear plantilla L-V 08:00-15:00 con 0 min de pausa (420 min = 7h)
    const tplRes = await request(app)
      .post('/api/v1/admin/shift-templates')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        employeeId: emp.employee.id,
        name: 'Mañanas L-V',
        weekdays: [1, 2, 3, 4, 5],
        startTimeMadrid: '08:00',
        endTimeMadrid: '15:00',
        crossesMidnight: false,
        plannedBreakMinutes: 0,
        facilityRef: 'PISCINA-25M',
        projectRef: 'CURSOS',
        validFrom: '2026-12-01',
        validTo: '2026-12-31',
      });
    expect(tplRes.status).toBe(201);
    const tplId = tplRes.body.template.id;

    // Generar 2 semanas exactas: 2026-12-07 (lun) a 2026-12-20 (dom) = 10 días laborables
    const gen1 = await request(app)
      .post('/api/v1/admin/shifts/generate')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        templateId: tplId,
        from: '2026-12-07',
        to: '2026-12-20',
      });
    expect(gen1.status).toBe(201);
    expect(gen1.body.createdCount).toBe(10);
    expect(gen1.body.shifts.every((s: { plannedMinutes: number }) => s.plannedMinutes === 420)).toBe(true);

    // Repetir generación en el mismo rango no duplica
    const gen2 = await request(app)
      .post('/api/v1/admin/shifts/generate')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        templateId: tplId,
        from: '2026-12-07',
        to: '2026-12-20',
      });
    expect(gen2.status).toBe(201);
    expect(gen2.body.createdCount).toBe(0);
    expect(gen2.body.skippedCount).toBe(10);

    // Marcar un día libre y probar que en una semana nueva no genera ese día
    await request(app)
      .post('/api/v1/admin/day-offs')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        employeeId: emp.employee.id,
        madridDate: '2026-12-25',
        type: 'holiday',
        note: 'Navidad',
      });

    const gen3 = await request(app)
      .post('/api/v1/admin/shifts/generate')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        templateId: tplId,
        from: '2026-12-21',
        to: '2026-12-27',
      });
    expect(gen3.status).toBe(201);
    expect(gen3.body.createdCount).toBe(4); // L, M, X, J (viernes 25 excluido por festivo)
  });

  it('2. Un turno nocturno que cruza medianoche tiene una única fecha de negocio', async () => {
    const admin = await loginAs('admin@mitaclock.es');
    const emp = await createEmployeeWithNoShifts(admin.cookie, 'nocturno@mitaclock.es', 'Jorge Nocturno');

    const res = await request(app)
      .post('/api/v1/admin/shifts')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        employeeId: emp.employee.id,
        madridDateKey: '2026-12-01',
        startTimeMadrid: '22:00',
        endTimeMadrid: '06:00',
        crossesMidnight: true,
        plannedBreakMinutes: 30,
        facilityRef: 'CENTRO-01',
      });
    expect(res.status).toBe(201);
    expect(res.body.shift.madridDateKey).toBe('2026-12-01');
    expect(res.body.shift.plannedMinutes).toBe(450); // 8h (480) - 30 min pausa = 450
    // 22:00 Madrid (UTC+1) = 21:00Z del 01, 06:00 Madrid del 02 = 05:00Z del 02
    expect(res.body.shift.startUtc).toBe('2026-12-01T21:00:00.000Z');
    expect(res.body.shift.endUtc).toBe('2026-12-02T05:00:00.000Z');

    const listRes = await request(app)
      .get(`/api/v1/admin/shifts?employeeId=${emp.employee.id}&from=2026-12-01&to=2026-12-02`)
      .set('Cookie', admin.cookie);
    expect(listRes.status).toBe(200);
    expect(listRes.body.shifts).toHaveLength(1);
    expect(listRes.body.shifts[0].madridDateKey).toBe('2026-12-01');
  });

  it('3. No se pueden solapar dos jornadas del mismo empleado (409)', async () => {
    const admin = await loginAs('admin@mitaclock.es');
    const emp = await createEmployeeWithNoShifts(admin.cookie, 'solape@mitaclock.es', 'Ana Solape');

    const first = await request(app)
      .post('/api/v1/admin/shifts')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        employeeId: emp.employee.id,
        madridDateKey: '2026-12-03',
        startTimeMadrid: '08:00',
        endTimeMadrid: '14:00',
        crossesMidnight: false,
        plannedBreakMinutes: 0,
      });
    expect(first.status).toBe(201);

    const overlap = await request(app)
      .post('/api/v1/admin/shifts')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        employeeId: emp.employee.id,
        madridDateKey: '2026-12-03',
        startTimeMadrid: '13:00',
        endTimeMadrid: '18:00',
        crossesMidnight: false,
        plannedBreakMinutes: 0,
      });
    expect(overlap.status).toBe(409);
    expect(overlap.headers['content-type']).toContain('application/problem+json');
  });

  it('4. Un empleado no puede crear ni ver jornadas de otros, ni usar rutas de admin (403)', async () => {
    const admin = await loginAs('admin@mitaclock.es');
    const empA = await createEmployeeWithNoShifts(admin.cookie, 'empa@mitaclock.es', 'Empleado A');
    const empB = await createEmployeeWithNoShifts(admin.cookie, 'empb@mitaclock.es', 'Empleado B');

    await request(app)
      .post('/api/v1/admin/shifts')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        employeeId: empB.employee.id,
        madridDateKey: '2026-11-23',
        startTimeMadrid: '08:00',
        endTimeMadrid: '15:00',
        crossesMidnight: false,
        plannedBreakMinutes: 0,
      });

    // Empleado A intenta acceder a rutas admin -> 403
    const createAttempt = await request(app)
      .post('/api/v1/admin/shifts')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', empA.cookie)
      .send({
        employeeId: empA.employee.id,
        madridDateKey: '2026-11-23',
        startTimeMadrid: '08:00',
        endTimeMadrid: '15:00',
      });
    expect(createAttempt.status).toBe(403);
    expect(createAttempt.headers['content-type']).toContain('application/problem+json');

    const adminListAttempt = await request(app)
      .get('/api/v1/admin/shifts')
      .set('Cookie', empA.cookie);
    expect(adminListAttempt.status).toBe(403);

    const openSessionsAttempt = await request(app)
      .get('/api/v1/admin/open-sessions')
      .set('Cookie', empA.cookie);
    expect(openSessionsAttempt.status).toBe(403);

    // Empleado A pide /clock/shifts?employeeId=empB -> solo ve las suyas o recibe 403 si pide de otro
    const otherShiftAttempt = await request(app)
      .get(`/api/v1/clock/shifts?from=2026-11-23&to=2026-11-23&employeeId=${empB.employee.id}`)
      .set('Cookie', empA.cookie);
    expect(otherShiftAttempt.status).toBe(403);

    const ownShifts = await request(app)
      .get('/api/v1/clock/shifts?from=2026-11-23&to=2026-11-23')
      .set('Cookie', empA.cookie);
    expect(ownShifts.status).toBe(200);
    expect(ownShifts.body.shifts).toHaveLength(0);
  });

  it('5. Con una jornada de 7h y reloj abierto, a fin + 15 min marca past_planned_end; a fin + 2h pasa a flagged y abre incidencia', async () => {
    const admin = await loginAs('admin@mitaclock.es');
    const emp = await createEmployeeWithNoShifts(admin.cookie, 'vigilancia@mitaclock.es', 'Mario Vigilancia');

    // Jornada planificada hoy 2026-11-23: 08:00 a 15:00 Madrid (07:00Z a 14:00Z, 420 min)
    await request(app)
      .post('/api/v1/admin/shifts')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        employeeId: emp.employee.id,
        madridDateKey: '2026-11-23',
        startTimeMadrid: '08:00',
        endTimeMadrid: '15:00',
        crossesMidnight: false,
        plannedBreakMinutes: 0,
      });

    // Inicia jornada a las 08:00 Madrid (07:00Z)
    currentNow = new Date('2026-11-23T07:00:00.000Z');
    await request(app)
      .post('/api/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', emp.cookie)
      .send({
        id: 'a1111111-1111-4111-8111-111111111111',
        type: 'shift_start',
        deviceDeclaredAt: currentNow.toISOString(),
        deviceOffsetMs: 60 * 60 * 1000,
      });

    // Avanzar a fin + 16 min (15:16 Madrid = 14:16Z) y ejecutar vigilancia
    currentNow = new Date('2026-11-23T14:16:00.000Z');
    await request(app)
      .post('/api/v1/admin/watchdog/run')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({});

    const today1 = await request(app)
      .get('/api/v1/clock/shifts/today')
      .set('Cookie', emp.cookie);
    expect(today1.status).toBe(200);
    expect(today1.body.activeSession.status).toBe('open');
    expect(today1.body.activeSession.anomalyFlags).toContain('past_planned_end');
    expect(today1.body.showOverrunPrompt).toBe(true);

    // Avanzar a fin + 2h05m (17:05 Madrid = 16:05Z) y ejecutar vigilancia
    currentNow = new Date('2026-11-23T16:05:00.000Z');
    await request(app)
      .post('/api/v1/admin/watchdog/run')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({});

    const openRes = await request(app)
      .get('/api/v1/admin/open-sessions')
      .set('Cookie', admin.cookie);
    expect(openRes.status).toBe(200);
    const flaggedRow = openRes.body.openSessions.find(
      (o: { session: { employeeId: string } }) => o.session.employeeId === emp.employee.id,
    );
    expect(flaggedRow).toBeDefined();
    expect(flaggedRow.session.status).toBe('flagged');
    expect(flaggedRow.incident).toBeTruthy();
    expect(flaggedRow.incident.status).toBe('open');
  });

  it('6. A las 12 h desde el inicio pasa a incomplete y permite fichar al día siguiente', async () => {
    const admin = await loginAs('admin@mitaclock.es');
    const emp = await createEmployeeWithNoShifts(admin.cookie, 'doceh@mitaclock.es', 'Luis Docehoras');

    currentNow = new Date('2026-11-23T07:00:00.000Z'); // 08:00 Madrid
    await request(app)
      .post('/api/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', emp.cookie)
      .send({
        id: 'a2222222-2222-4222-8222-222222222221',
        type: 'shift_start',
        deviceDeclaredAt: currentNow.toISOString(),
        deviceOffsetMs: 60 * 60 * 1000,
      });

    // 12 h 05 min después -> 19:05Z
    currentNow = new Date('2026-11-23T19:05:00.000Z');
    await request(app)
      .post('/api/v1/admin/watchdog/run')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({});

    const sessionsRes = await request(app)
      .get('/api/v1/clock/sessions')
      .set('Cookie', emp.cookie);
    expect(sessionsRes.body.sessions[0].status).toBe('incomplete');

    // Al día siguiente (2026-11-24T07:00Z), NO bloquea iniciar otra jornada
    currentNow = new Date('2026-11-24T07:00:00.000Z');
    const nextDayStart = await request(app)
      .post('/api/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', emp.cookie)
      .send({
        id: 'a2222222-2222-4222-8222-222222222222',
        type: 'shift_start',
        deviceDeclaredAt: currentNow.toISOString(),
        deviceOffsetMs: 60 * 60 * 1000,
      });
    expect(nextDayStart.status).toBe(201);
  });

  it('7. El proceso de vigilancia nunca crea un evento shift_end', async () => {
    const admin = await loginAs('admin@mitaclock.es');
    const emp = await createEmployeeWithNoShifts(admin.cookie, 'noclose@mitaclock.es', 'Paula Noclose');

    await request(app)
      .post('/api/v1/admin/shifts')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        employeeId: emp.employee.id,
        madridDateKey: '2026-11-23',
        startTimeMadrid: '08:00',
        endTimeMadrid: '15:00',
        crossesMidnight: false,
        plannedBreakMinutes: 0,
      });

    currentNow = new Date('2026-11-23T07:00:00.000Z');
    await request(app)
      .post('/api/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', emp.cookie)
      .send({
        id: 'a3333333-3333-4333-8333-333333333331',
        type: 'shift_start',
        deviceDeclaredAt: currentNow.toISOString(),
        deviceOffsetMs: 0,
      });

    // Avanzar 14 horas y ejecutar vigilancia varias veces
    currentNow = new Date('2026-11-23T21:00:00.000Z');
    await request(app)
      .post('/api/v1/admin/watchdog/run')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({});

    const eventsRes = await request(app)
      .get(`/api/clock-events?employeeId=${emp.employee.id}`)
      .set('Cookie', admin.cookie);
    expect(eventsRes.body.events).toHaveLength(1);
    expect(eventsRes.body.events.some((e: { type: string }) => e.type === 'shift_end')).toBe(false);
  });

  it('8. Con cap_provisional el tiempo efectivo queda limitado y provisional; con flag_only sigue contando; al corregir recalcula', async () => {
    const admin = await loginAs('admin@mitaclock.es');
    const emp = await createEmployeeWithNoShifts(admin.cookie, 'cap@mitaclock.es', 'Clara Cap');

    // Planificado 08:00-15:00 (07:00Z-14:00Z, 420 min), tolerancia 30 min -> tope provisional = 450 min
    await request(app)
      .post('/api/v1/admin/shifts')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        employeeId: emp.employee.id,
        madridDateKey: '2026-11-23',
        startTimeMadrid: '08:00',
        endTimeMadrid: '15:00',
        crossesMidnight: false,
        plannedBreakMinutes: 0,
      });

    currentNow = new Date('2026-11-23T07:00:00.000Z');
    await request(app)
      .post('/api/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', emp.cookie)
      .send({
        id: 'a4444444-4444-4444-8444-444444444441',
        type: 'shift_start',
        deviceDeclaredAt: currentNow.toISOString(),
        deviceOffsetMs: 0,
      });

    // Avanzar a 17:30 Madrid (16:30Z -> 9h30m = 570 min reales, > fin + 2h)
    currentNow = new Date('2026-11-23T16:30:00.000Z');

    // Por defecto flag_only: sigue contando 570 min
    await request(app)
      .post('/api/v1/admin/watchdog/run')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({});

    const sFlagOnly = await request(app)
      .get('/api/v1/clock/sessions')
      .set('Cookie', emp.cookie);
    expect(sFlagOnly.body.sessions[0].workedMinutes).toBe(570);
    expect(sFlagOnly.body.sessions[0].isProvisionalCap).toBe(false);

    // Cambiar política a cap_provisional
    const polRes = await request(app)
      .put('/api/v1/admin/policies')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({ overrunPolicy: 'cap_provisional' });
    expect(polRes.status).toBe(200);

    const sCap = await request(app)
      .get('/api/v1/clock/sessions')
      .set('Cookie', emp.cookie);
    expect(sCap.body.sessions[0].workedMinutes).toBe(450); // 420 + 30 tolerancia
    expect(sCap.body.sessions[0].isProvisionalCap).toBe(true);

    // Al añadir la salida real a las 16:00 Madrid (15:00Z = 480 min) vía corrección aprobada, recalcula a 480
    const corrRes = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'cap-resolve-1')
      .set('Cookie', emp.cookie)
      .send({
        targetEventId: null,
        kind: 'add_event',
        reason: 'Salí a las 16:00 tras recoger material de pista y olvidé fichar salida',
        proposedChange: {
          eventType: 'shift_end',
          declaredAtUtc: '2026-11-23T15:00:00.000Z',
        },
      });
    expect(corrRes.status).toBe(201);

    const appRes = await request(app)
      .post(`/api/v1/clock/corrections/${corrRes.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({ resolutionNote: 'Salida real verificada' });
    expect(appRes.status).toBe(200);

    const sAfter = await request(app)
      .get('/api/v1/clock/sessions')
      .set('Cookie', emp.cookie);
    expect(sAfter.body.sessions[0].workedMinutes).toBe(480);
    expect(sAfter.body.sessions[0].isProvisionalCap).toBe(false);
    expect(sAfter.body.sessions[0].status).toBe('closed');
  });

  it('9. «Sigo trabajando» registra el motivo y overrun_acknowledged', async () => {
    const admin = await loginAs('admin@mitaclock.es');
    const emp = await createEmployeeWithNoShifts(admin.cookie, 'overrun@mitaclock.es', 'Eva Overrun');

    await request(app)
      .post('/api/v1/admin/shifts')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        employeeId: emp.employee.id,
        madridDateKey: '2026-11-23',
        startTimeMadrid: '08:00',
        endTimeMadrid: '15:00',
        crossesMidnight: false,
        plannedBreakMinutes: 0,
      });

    currentNow = new Date('2026-11-23T07:00:00.000Z');
    await request(app)
      .post('/api/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', emp.cookie)
      .send({
        id: 'a5555555-5555-4555-8555-555555555551',
        type: 'shift_start',
        deviceDeclaredAt: currentNow.toISOString(),
        deviceOffsetMs: 0,
      });

    // 15:20 Madrid -> aparece aviso
    currentNow = new Date('2026-11-23T14:20:00.000Z');
    const todayBefore = await request(app)
      .get('/api/v1/clock/shifts/today')
      .set('Cookie', emp.cookie);
    expect(todayBefore.body.showOverrunPrompt).toBe(true);
    const sessionId = todayBefore.body.activeSession.id;

    const ackRes = await request(app)
      .post(`/api/v1/clock/sessions/${sessionId}/acknowledge-overrun`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', emp.cookie)
      .send({ reason: 'Turno ampliado autorizado' });
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.session.overrunAcknowledged).toBe(true);
    expect(ackRes.body.session.overrunReason).toBe('Turno ampliado autorizado');

    const todayAfter = await request(app)
      .get('/api/v1/clock/shifts/today')
      .set('Cookie', emp.cookie);
    expect(todayAfter.body.showOverrunPrompt).toBe(false);
    expect(todayAfter.body.activeSession.overrunAcknowledged).toBe(true);
  });

  it('10. Fichar sin jornada planificada se permite y marca no_planned_shift; con require_planned_shift activo se rechaza con 422', async () => {
    const admin = await loginAs('admin@mitaclock.es');
    const emp = await createEmployeeWithNoShifts(admin.cookie, 'sinplan@mitaclock.es', 'Sergio Sinplan');

    currentNow = new Date('2026-11-23T08:00:00.000Z');
    const allowedRes = await request(app)
      .post('/api/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', emp.cookie)
      .send({
        id: 'a6666666-6666-4666-8666-666666666661',
        type: 'shift_start',
        deviceDeclaredAt: currentNow.toISOString(),
        deviceOffsetMs: 0,
      });
    expect(allowedRes.status).toBe(201);

    const sessRes = await request(app)
      .get('/api/v1/clock/sessions')
      .set('Cookie', emp.cookie);
    expect(sessRes.body.sessions[0].anomalyFlags).toContain('no_planned_shift');

    // Activar require_planned_shift
    await request(app)
      .put('/api/v1/admin/policies')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({ requirePlannedShift: true });

    const emp2 = await createEmployeeWithNoShifts(admin.cookie, 'reqplan@mitaclock.es', 'Elena Reqplan');
    const blockedRes = await request(app)
      .post('/api/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', emp2.cookie)
      .send({
        id: 'a6666666-6666-4666-8666-666666666662',
        type: 'shift_start',
        deviceDeclaredAt: currentNow.toISOString(),
        deviceOffsetMs: 0,
      });
    expect(blockedRes.status).toBe(422);
  });

  it('11. Resolver una jornada abierta desde el admin usa el módulo de correcciones y deja el evento original intacto', async () => {
    const admin1 = await loginAs('admin@mitaclock.es');
    await request(app)
      .post('/api/admin/employees')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin1.cookie)
      .send({
        name: 'Segundo Admin',
        email: 'admin2@mitaclock.es',
        password: 'password-admin-2',
        role: 'admin',
      });
    const admin2Login = await request(app)
      .post('/api/auth/login')
      .set('X-Requested-With', 'MiTaClock')
      .send({ email: 'admin2@mitaclock.es', password: 'password-admin-2' });
    const admin2Cookie = admin2Login.headers['set-cookie'] as unknown as string[];

    const emp = await createEmployeeWithNoShifts(admin1.cookie, 'resolver@mitaclock.es', 'Raúl Resolver');
    await request(app)
      .post('/api/v1/admin/shifts')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin1.cookie)
      .send({
        employeeId: emp.employee.id,
        madridDateKey: '2026-11-23',
        startTimeMadrid: '08:00',
        endTimeMadrid: '15:00',
        crossesMidnight: false,
        plannedBreakMinutes: 0,
      });

    const startId = 'a7777777-7777-4777-8777-777777777771';
    currentNow = new Date('2026-11-23T07:00:00.000Z');
    await request(app)
      .post('/api/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', emp.cookie)
      .send({
        id: startId,
        type: 'shift_start',
        deviceDeclaredAt: currentNow.toISOString(),
        deviceOffsetMs: 0,
      });

    // Avanzar a 17:30 Madrid (>2h tras 15:00) y ejecutar vigilancia -> incidencia abierta
    currentNow = new Date('2026-11-23T16:30:00.000Z');
    await request(app)
      .post('/api/v1/admin/watchdog/run')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin1.cookie)
      .send({});

    // Admin 1 crea corrección add_event para resolver la jornada abierta con hora real 15:00 Madrid (14:00Z)
    const corrCreate = await request(app)
      .post('/api/v1/clock/corrections')
      .set('X-Requested-With', 'MiTaClock')
      .set('Idempotency-Key', 'admin-resolve-open-1')
      .set('Cookie', admin1.cookie)
      .send({
        employeeId: emp.employee.id,
        targetEventId: null,
        kind: 'add_event',
        reason: 'El empleado salió a su hora (15:00) y olvidó fichar la salida',
        proposedChange: {
          eventType: 'shift_end',
          declaredAtUtc: '2026-11-23T14:00:00.000Z',
        },
      });
    expect(corrCreate.status).toBe(201);

    // Admin 2 aprueba la corrección -> cierra sesión e incidencia, manteniendo startId intacto
    const approve = await request(app)
      .post(`/api/v1/clock/corrections/${corrCreate.body.correction.id}/approve`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin2Cookie)
      .send({ resolutionNote: 'Validado cierre real a las 15:00' });
    expect(approve.status).toBe(200);

    const eventsRes = await request(app)
      .get(`/api/clock-events?employeeId=${emp.employee.id}`)
      .set('Cookie', admin1.cookie);
    expect(eventsRes.body.events).toHaveLength(2);
    expect(eventsRes.body.events[0].id).toBe(startId);
    expect(eventsRes.body.events[1].type).toBe('shift_end');
    expect(eventsRes.body.events[1].source).toBe('admin');

    const openRes = await request(app)
      .get('/api/v1/admin/open-sessions')
      .set('Cookie', admin1.cookie);
    const stillOpen = openRes.body.openSessions.find(
      (o: { session: { employeeId: string } }) => o.session.employeeId === emp.employee.id,
    );
    expect(stillOpen).toBeUndefined();
  });

  it('12. El resumen diario devuelve planned_minutes, worked_minutes y delta_minutes correctos', async () => {
    const admin = await loginAs('admin@mitaclock.es');
    const emp = await createEmployeeWithNoShifts(admin.cookie, 'resumen@mitaclock.es', 'Lucía Resumen');

    // Planificado 08:00-15:00 (420 min)
    await request(app)
      .post('/api/v1/admin/shifts')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        employeeId: emp.employee.id,
        madridDateKey: '2026-11-23',
        startTimeMadrid: '08:00',
        endTimeMadrid: '15:00',
        crossesMidnight: false,
        plannedBreakMinutes: 0,
      });

    // Trabajado real: 08:00 a 15:30 Madrid (07:00Z a 14:30Z = 450 min) -> delta +30
    currentNow = new Date('2026-11-23T07:00:00.000Z');
    await request(app)
      .post('/api/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', emp.cookie)
      .send({
        id: 'a8888888-8888-4888-8888-888888888881',
        type: 'shift_start',
        deviceDeclaredAt: '2026-11-23T07:00:00.000Z',
        deviceOffsetMs: 0,
      });

    currentNow = new Date('2026-11-23T14:30:00.000Z');
    await request(app)
      .post('/api/clock-events')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', emp.cookie)
      .send({
        id: 'a8888888-8888-4888-8888-888888888882',
        type: 'shift_end',
        deviceDeclaredAt: '2026-11-23T14:30:00.000Z',
        deviceOffsetMs: 0,
      });

    const summaryRes = await request(app)
      .get(`/api/v1/admin/daily-summary?from=2026-11-23&to=2026-11-23&employeeId=${emp.employee.id}`)
      .set('Cookie', admin.cookie);
    expect(summaryRes.status).toBe(200);
    expect(summaryRes.body.rows).toHaveLength(1);
    expect(summaryRes.body.rows[0]).toMatchObject({
      employeeId: emp.employee.id,
      madridDate: '2026-11-23',
      plannedMinutes: 420,
      workedMinutes: 450,
      deltaMinutes: 30,
    });
  });

  it('13. Cada cambio en jornadas planificadas queda en audit_log (crear, editar y eliminar)', async () => {
    const admin = await loginAs('admin@mitaclock.es');
    const emp = await createEmployeeWithNoShifts(admin.cookie, 'auditplan@mitaclock.es', 'Nora Audit');

    const createRes = await request(app)
      .post('/api/v1/admin/shifts')
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        employeeId: emp.employee.id,
        madridDateKey: '2026-11-25',
        startTimeMadrid: '08:00',
        endTimeMadrid: '14:00',
        crossesMidnight: false,
        plannedBreakMinutes: 0,
      });
    expect(createRes.status).toBe(201);
    const shiftId = createRes.body.shift.id;

    const updateRes = await request(app)
      .put(`/api/v1/admin/shifts/${shiftId}`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie)
      .send({
        startTimeMadrid: '09:00',
        endTimeMadrid: '16:00',
        crossesMidnight: false,
        plannedBreakMinutes: 30,
      });
    expect(updateRes.status).toBe(200);

    const deleteRes = await request(app)
      .delete(`/api/v1/admin/shifts/${shiftId}`)
      .set('X-Requested-With', 'MiTaClock')
      .set('Cookie', admin.cookie);
    expect(deleteRes.status).toBe(200);

    const auditRes = await request(app)
      .get('/api/v1/admin/audit-log?limit=50')
      .set('Cookie', admin.cookie);
    expect(auditRes.status).toBe(200);

    const actions = auditRes.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain('planned_shift.created');
    expect(actions).toContain('planned_shift.updated');
    expect(actions).toContain('planned_shift.deleted');

    const updatedEntry = auditRes.body.entries.find(
      (e: { action: string; entityId: string }) =>
        e.action === 'planned_shift.updated' && e.entityId === shiftId,
    );
    expect(updatedEntry.details.before).toBeTruthy();
    expect(updatedEntry.details.after).toBeTruthy();
    expect(updatedEntry.details.before.plannedMinutes).toBe(360);
    expect(updatedEntry.details.after.plannedMinutes).toBe(390);
  });
});

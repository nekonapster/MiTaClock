import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PgClockRepository } from '../server/pgRepository';
import { createTestPgRepo } from './pgTestHelper';

describe('PgClockRepository — modelo append-only, migraciones, semillas e idempotencia', () => {
  let repo: PgClockRepository;

  beforeEach(async () => {
    repo = await createTestPgRepo({ seedDemoData: true });
  });

  afterEach(async () => {
    await repo.close();
  });

  it('siembra 1 admin, 3 empleados con cambio de contraseña obligatorio y tipos de pausa solo si SEED_DEMO_DATA=true', async () => {
    const employees = await repo.listEmployees();
    const breakTypes = await repo.listBreakTypes();
    const admin = await repo.findUserByEmail('admin@mitaclock.es');

    expect(admin).not.toBeNull();
    expect(admin?.role).toBe('admin');
    expect(admin?.mustChangePassword).toBe(true);
    expect(employees.length).toBe(3);
    expect(breakTypes.length).toBeGreaterThanOrEqual(3);

    // Con SEED_DEMO_DATA=false en una BD vacía no siembra usuarios demo
    const emptyRepo = await createTestPgRepo({ seedDemoData: false });
    try {
      const noEmployees = await emptyRepo.listEmployees(true);
      const noAdmin = await emptyRepo.findUserByEmail('admin@mitaclock.es');
      const breaksStillExist = await emptyRepo.listBreakTypes();
      expect(noEmployees).toHaveLength(0);
      expect(noAdmin).toBeNull();
      expect(breaksStillExist.length).toBeGreaterThanOrEqual(3);

      // Si se configura bootstrapAdmin en una BD vacía sin demo data, crea el administrador listo para usar
      await emptyRepo.initAndSeed({
        seedDemoData: false,
        bootstrapAdmin: {
          email: 'jefe@mitaclock.es',
          password: 'ClaveAdmin2026!',
          name: 'Admin Principal',
        },
      });
      const bootAdmin = await emptyRepo.findUserByEmail('jefe@mitaclock.es');
      expect(bootAdmin).not.toBeNull();
      expect(bootAdmin?.role).toBe('admin');
      expect(bootAdmin?.mustChangePassword).toBe(false);
      expect(bootAdmin?.passwordHash).toBeTruthy();
    } finally {
      await emptyRepo.close();
    }
  });

  it('repara el acceso de cuentas demo sin contraseña o bloqueadas en entorno de pruebas cuando repairDemoAccounts=true', async () => {
    const brokenRepo = await createTestPgRepo({ seedDemoData: true, demoMustChangePassword: true });
    try {
      const before = await brokenRepo.findUserByEmail('admin@mitaclock.es');
      expect(before?.passwordHash).toBeNull();
      expect(before?.mustChangePassword).toBe(true);

      await brokenRepo.initAndSeed({
        seedDemoData: true,
        seedDemoPassword: 'MiTaDemo2026!',
        demoMustChangePassword: false,
        repairDemoAccounts: true,
      });

      const after = await brokenRepo.findUserByEmail('admin@mitaclock.es');
      expect(after?.passwordHash).toBeTruthy();
      expect(after?.mustChangePassword).toBe(false);
      expect(after?.isActive).toBe(true);
    } finally {
      await brokenRepo.close();
    }
  });

  it('impide UPDATE y DELETE sobre clock_events mediante triggers PostgreSQL', async () => {
    const employees = await repo.listEmployees();
    const emp = employees[0];

    await repo.insertClockEvent({
      id: '11111111-1111-4111-8111-111111111111',
      employeeId: emp.id,
      type: 'shift_start',
      breakTypeId: null,
      receivedAt: '2026-11-21T08:00:00.000Z',
      deviceDeclaredAt: '2026-11-21T08:00:00.000Z',
      deviceOffsetMs: 0,
      timeSource: 'server',
      assignmentRef: 'ASIG-101',
      projectRef: 'PRJ-PADEL',
      facilityRef: 'PISTA-1',
    });

    await expect(
      repo.rawExecForTest(
        `UPDATE clock_events SET type = 'shift_end' WHERE id = '11111111-1111-4111-8111-111111111111'`,
      ),
    ).rejects.toThrow(/append-only/i);

    await expect(
      repo.rawExecForTest(
        `DELETE FROM clock_events WHERE id = '11111111-1111-4111-8111-111111111111'`,
      ),
    ).rejects.toThrow(/append-only/i);
  });

  it('garantiza idempotencia por UUID y transiciona a confirmado vía sync_acknowledgements', async () => {
    const employees = await repo.listEmployees();
    const emp = employees[0];
    const eventId = '22222222-2222-4222-8222-222222222222';

    const first = await repo.insertClockEvent({
      id: eventId,
      employeeId: emp.id,
      type: 'shift_start',
      breakTypeId: null,
      receivedAt: '2026-11-21T08:00:00.000Z',
      deviceDeclaredAt: '2026-11-21T08:00:00.000Z',
      deviceOffsetMs: 0,
      timeSource: 'server',
      assignmentRef: null,
      projectRef: null,
      facilityRef: null,
    });
    expect(first.deduplicated).toBe(false);
    expect(first.event.syncStatus).toBe('enviado');

    const duplicate = await repo.insertClockEvent({
      id: eventId,
      employeeId: emp.id,
      type: 'shift_start',
      breakTypeId: null,
      receivedAt: '2026-11-21T08:05:00.000Z',
      deviceDeclaredAt: '2026-11-21T08:00:00.000Z',
      deviceOffsetMs: 0,
      timeSource: 'device_declared',
      assignmentRef: null,
      projectRef: null,
      facilityRef: null,
    });
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.event.receivedAt).toBe('2026-11-21T08:00:00.000Z');

    await repo.acknowledgeEvents([eventId], 'MITA-ACK-001', '2026-11-21T08:02:00.000Z');
    const events = await repo.listClockEvents({ employeeId: emp.id });
    expect(events[0].syncStatus).toBe('confirmado');
    expect(events[0].mitaAckRef).toBe('MITA-ACK-001');
  });
});

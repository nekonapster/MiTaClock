import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  addDaysToDateKey,
  getMadridDateKey,
  getMondayOfWeek,
} from '../shared/timeEngine.ts';
import { computePlannedShiftBounds, expandTemplateInRange } from '../shared/planningEngine.ts';
import type {
  AnomalyFlag,
  AuditLogEntry,
  BreakType,
  ClockEvent,
  ClockEventType,
  ClockPolicy,
  CorrectionKind,
  CorrectionPreview,
  CorrectionRequest,
  CorrectionStatus,
  DayOff,
  DayOffType,
  DemoAccountInfo,
  Employee,
  EventSource,
  IncidentKind,
  IncidentStatus,
  InsertClockEventInput,
  MitaCorrectionOutboxPayload,
  MitaExportEvent,
  MitaOutboxItem,
  OverrunPolicy,
  PlannedShift,
  PlannedShiftSource,
  ProposedCorrectionChange,
  SessionIncident,
  ShiftTemplate,
  SyncStatus,
  TimeSource,
  UserPublic,
  UserRecord,
  UserRole,
  WorkSession,
  WorkSessionStatus,
} from '../shared/types.ts';
import {
  createPgPoolExecutor,
  runMigrationsWithAdvisoryLock,
  type SqlExecutor,
  type SqlRunner,
} from './pgConnection.ts';
import type {
  ApproveCorrectionAtomicInput,
  ApproveCorrectionAtomicResult,
  ClockRepository,
  CreateAuditLogInput,
  CreateBreakTypeInput,
  CreateCorrectionInput,
  CreateDayOffInput,
  CreatePlannedShiftInput,
  CreateShiftTemplateInput,
  CreateUserEmployeeInput,
  InitAndSeedOptions,
  InsertClockEventResult,
  ListClockEventsFilter,
  ListCorrectionsFilter,
  ListPlannedShiftsFilter,
  UpdateBreakTypeInput,
  UpdateClockPolicyInput,
  UpdateEmployeeInput,
  UpdatePlannedShiftInput,
  UpdateShiftTemplateInput,
  UpsertSessionIncidentInput,
} from './repository.ts';

interface DemoSeedDefinition {
  userId: string;
  employeeId: string;
  email: string;
  role: UserRole;
  name: string;
  externalRef: string | null;
  areaLabel: string;
}

const DEMO_SEEDS: DemoSeedDefinition[] = [
  {
    userId: '10000000-0000-4000-8000-000000000001',
    employeeId: '20000000-0000-4000-8000-000000000001',
    email: 'admin@mitaclock.es',
    role: 'admin',
    name: 'Elena Morales (Admin)',
    externalRef: 'MITA-ADM-001',
    areaLabel: 'Dirección del Centro',
  },
  {
    userId: '10000000-0000-4000-8000-000000000002',
    employeeId: '20000000-0000-4000-8000-000000000002',
    email: 'lucia@mitaclock.es',
    role: 'employee',
    name: 'Lucía Fernández',
    externalRef: 'MITA-EMP-101',
    areaLabel: 'Pádel y Tenis',
  },
  {
    userId: '10000000-0000-4000-8000-000000000003',
    employeeId: '20000000-0000-4000-8000-000000000003',
    email: 'carlos@mitaclock.es',
    role: 'employee',
    name: 'Carlos Ruiz',
    externalRef: 'MITA-EMP-102',
    areaLabel: 'Sala Fitness y Natación',
  },
  {
    userId: '10000000-0000-4000-8000-000000000004',
    employeeId: '20000000-0000-4000-8000-000000000004',
    email: 'sofia@mitaclock.es',
    role: 'employee',
    name: 'Sofía Navarro',
    externalRef: 'MITA-EMP-103',
    areaLabel: 'Recepción y Atención',
  },
];

export interface PgClockRepositoryConfig {
  connectionString?: string;
  unpooledConnectionString?: string;
  executor?: SqlExecutor;
}

export class PgClockRepository implements ClockRepository {
  private readonly executor: SqlExecutor;
  private readonly unpooledConnectionString?: string;

  constructor(config: PgClockRepositoryConfig) {
    if (config.executor) {
      this.executor = config.executor;
    } else if (config.connectionString) {
      this.executor = createPgPoolExecutor(config.connectionString);
    } else {
      throw new Error('PgClockRepository requiere executor o connectionString.');
    }
    this.unpooledConnectionString = config.unpooledConnectionString;
  }

  getExecutor(): SqlExecutor {
    return this.executor;
  }

  async rawExecForTest(sql: string): Promise<void> {
    await this.executor.exec(sql);
  }

  async ping(timeoutMs: number = 2_500): Promise<boolean> {
    return this.executor.ping(timeoutMs);
  }

  async close(): Promise<void> {
    await this.executor.close();
  }

  async initAndSeed(options: InitAndSeedOptions = {}): Promise<void> {
    await runMigrationsWithAdvisoryLock(this.executor, this.unpooledConnectionString);

    const now = new Date().toISOString();

    await this.executor.query(
      `
        INSERT INTO clock_policies (
          id, past_planned_end_minutes, flag_after_end_minutes, max_open_hours,
          max_daily_minutes, schedule_tolerance_minutes, overrun_policy, require_planned_shift, updated_at
        ) VALUES ('default', 15, 120, 12, 720, 30, 'flag_only', FALSE, $1)
        ON CONFLICT (id) DO NOTHING
      `,
      [now],
    );

    const breakCountRes = await this.executor.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM break_types',
    );
    if ((breakCountRes.rows[0]?.cnt ?? 0) === 0) {
      const defaultBreaks = [
        ['30000000-0000-4000-8000-000000000001', 'DESCANSO', 'Descanso reglamentario', true],
        ['30000000-0000-4000-8000-000000000002', 'COMIDA', 'Pausa comida', false],
        ['30000000-0000-4000-8000-000000000003', 'GESTION', 'Preparación de pista / sala', true],
      ] as const;
      for (const [id, code, name, isPaid] of defaultBreaks) {
        await this.executor.query(
          `
            INSERT INTO break_types (id, code, name, is_paid, is_active, created_at)
            VALUES ($1, $2, $3, $4, TRUE, $5)
            ON CONFLICT (id) DO NOTHING
          `,
          [id, code, name, isPaid, now],
        );
      }
    }

    const shouldSeedDemo =
      options.seedDemoData ?? process.env.SEED_DEMO_DATA?.trim().toLowerCase() === 'true';
    if (!shouldSeedDemo) {
      return;
    }

    const countRes = await this.executor.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM users',
    );
    if ((countRes.rows[0]?.cnt ?? 0) === 0) {
      const seedPassword =
        options.seedDemoPassword ?? process.env.SEED_DEMO_PASSWORD?.trim() ?? '';
      const seedHash = seedPassword ? bcrypt.hashSync(seedPassword, 10) : null;
      const mustChangePassword = options.demoMustChangePassword ?? true;

      await this.executor.withTransaction(async (tx) => {
        for (const seed of DEMO_SEEDS) {
          await tx.query(
            `
              INSERT INTO users (
                id, email, password_hash, role, is_active, is_demo, must_change_password, created_at
              ) VALUES ($1, $2, $3, $4, TRUE, TRUE, $5, $6)
            `,
            [seed.userId, seed.email, seedHash, seed.role, mustChangePassword, now],
          );
          await tx.query(
            `
              INSERT INTO employees (id, user_id, external_ref, name, status, created_at)
              VALUES ($1, $2, $3, $4, 'active', $5)
            `,
            [seed.employeeId, seed.userId, seed.externalRef, seed.name, now],
          );
        }
      });

      await this.seedDemoPlanning(now);
    }
  }

  private async seedDemoPlanning(nowIso: string): Promise<void> {
    const todayKey = getMadridDateKey(nowIso);
    const mondayCurrent = getMondayOfWeek(todayKey);
    const sundayNext = addDaysToDateKey(mondayCurrent, 13);

    const demoConfigs = [
      {
        templateId: '40000000-0000-4000-8000-000000000001',
        employeeId: '20000000-0000-4000-8000-000000000002',
        name: 'Mañanas Pádel L-V',
        start: '08:00',
        end: '14:00',
        facility: 'PADEL-EXT',
        project: 'ESCUELA-PADEL',
      },
      {
        templateId: '40000000-0000-4000-8000-000000000002',
        employeeId: '20000000-0000-4000-8000-000000000003',
        name: 'Sala Fitness L-V',
        start: '08:00',
        end: '14:00',
        facility: 'FITNESS-01',
        project: 'ENTRENAMIENTO',
      },
      {
        templateId: '40000000-0000-4000-8000-000000000003',
        employeeId: '20000000-0000-4000-8000-000000000004',
        name: 'Recepción L-V',
        start: '09:00',
        end: '15:00',
        facility: 'RECEP-01',
        project: 'ATENCION-SOCIOS',
      },
    ];

    for (const cfg of demoConfigs) {
      const tpl = await this.createShiftTemplate({
        id: cfg.templateId,
        employeeId: cfg.employeeId,
        name: cfg.name,
        weekdays: [1, 2, 3, 4, 5],
        startTimeMadrid: cfg.start,
        endTimeMadrid: cfg.end,
        crossesMidnight: false,
        plannedBreakMinutes: 0,
        projectRef: cfg.project,
        facilityRef: cfg.facility,
        validFrom: '2026-01-01',
        validTo: null,
        isActive: true,
        createdAt: nowIso,
      });

      const existing = await this.listPlannedShifts({ employeeId: cfg.employeeId });
      const { toCreate } = expandTemplateInRange({
        template: tpl,
        fromDateKey: mondayCurrent,
        toDateKey: sundayNext,
        existingShifts: existing,
        dayOffs: [],
      });

      const refRange = expandTemplateInRange({
        template: tpl,
        fromDateKey: '2026-11-16',
        toDateKey: '2026-11-20',
        existingShifts: [
          ...existing,
          ...toCreate.map((c) => ({
            id: c.madridDateKey,
            employeeId: cfg.employeeId,
            madridDateKey: c.madridDateKey,
            startUtc: c.startUtc,
            endUtc: c.endUtc,
            plannedBreakMinutes: c.plannedBreakMinutes,
            plannedMinutes: c.plannedMinutes,
            projectRef: c.projectRef,
            facilityRef: c.facilityRef,
            assignmentRef: null,
            source: 'local' as const,
            label: c.label,
          })),
        ],
        dayOffs: [],
      });

      for (const item of [...toCreate, ...refRange.toCreate]) {
        const bounds = computePlannedShiftBounds({
          madridDateKey: item.madridDateKey,
          startTimeMadrid: cfg.start,
          endTimeMadrid: cfg.end,
          crossesMidnight: false,
          plannedBreakMinutes: 0,
        });
        if (!bounds.ok) continue;
        await this.createPlannedShift({
          id: crypto.randomUUID(),
          employeeId: cfg.employeeId,
          madridDateKey: item.madridDateKey,
          startUtc: item.startUtc,
          endUtc: item.endUtc,
          plannedBreakMinutes: item.plannedBreakMinutes,
          plannedMinutes: item.plannedMinutes,
          projectRef: item.projectRef,
          facilityRef: item.facilityRef,
          assignmentRef: `CUADRANTE-${item.madridDateKey}`,
          source: 'local',
          templateId: tpl.id,
          label: item.label,
          createdAt: nowIso,
        });
      }
    }
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const res = await this.executor.query<{
      id: string;
      email: string;
      password_hash: string | null;
      role: UserRole;
      is_active: boolean;
      is_demo: boolean;
      must_change_password: boolean;
      created_at: unknown;
    }>(
      `
        SELECT id, email, password_hash, role, is_active, is_demo, must_change_password, created_at
        FROM users
        WHERE LOWER(email) = LOWER($1)
      `,
      [email.trim()],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      role: row.role,
      isActive: Boolean(row.is_active),
      isDemo: Boolean(row.is_demo),
      mustChangePassword: Boolean(row.must_change_password),
      createdAt: toUtcIso(row.created_at),
    };
  }

  async findUserPublicById(userId: string): Promise<UserPublic | null> {
    const res = await this.executor.query<{
      id: string;
      email: string;
      role: UserRole;
      is_active: boolean;
      must_change_password: boolean;
      employee_id: string | null;
      employee_name: string | null;
      external_ref: string | null;
    }>(
      `
        SELECT u.id, u.email, u.role, u.is_active, u.must_change_password,
               e.id AS employee_id, e.name AS employee_name, e.external_ref
        FROM users u
        LEFT JOIN employees e ON e.user_id = u.id
        WHERE u.id = $1
      `,
      [userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      isActive: Boolean(row.is_active),
      mustChangePassword: Boolean(row.must_change_password),
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      externalRef: row.external_ref,
    };
  }

  async updateUserPasswordHash(
    userId: string,
    passwordHash: string,
    mustChangePassword: boolean,
  ): Promise<void> {
    await this.executor.query(
      `
        UPDATE users
        SET password_hash = $1, must_change_password = $2
        WHERE id = $3
      `,
      [passwordHash, mustChangePassword, userId],
    );
  }

  async listDemoAccounts(): Promise<DemoAccountInfo[]> {
    const areaMap = new Map(DEMO_SEEDS.map((s) => [s.email, s.areaLabel]));
    const res = await this.executor.query<{
      email: string;
      role: UserRole;
      name: string;
      external_ref: string | null;
    }>(`
      SELECT u.email, u.role, e.name, e.external_ref
      FROM users u
      JOIN employees e ON e.user_id = u.id
      WHERE u.is_demo = TRUE AND u.is_active = TRUE
      ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, e.name ASC
    `);
    return res.rows.map((r) => ({
      email: r.email,
      name: r.name,
      role: r.role,
      externalRef: r.external_ref,
      areaLabel: areaMap.get(r.email) ?? 'Centro Deportivo',
    }));
  }

  async listEmployees(includeAdmins: boolean = false): Promise<Employee[]> {
    const whereClause = includeAdmins ? '' : "WHERE u.role = 'employee'";
    const res = await this.executor.query<RawEmployeeRow>(`
      SELECT e.id, e.user_id, u.email, u.role, e.external_ref, e.name, e.status, u.is_active, e.created_at
      FROM employees e
      JOIN users u ON u.id = e.user_id
      ${whereClause}
      ORDER BY e.name ASC
    `);
    return res.rows.map(mapEmployeeRow);
  }

  async findEmployeeByUserId(userId: string): Promise<Employee | null> {
    const res = await this.executor.query<RawEmployeeRow>(
      `
        SELECT e.id, e.user_id, u.email, u.role, e.external_ref, e.name, e.status, u.is_active, e.created_at
        FROM employees e
        JOIN users u ON u.id = e.user_id
        WHERE e.user_id = $1
      `,
      [userId],
    );
    return res.rows[0] ? mapEmployeeRow(res.rows[0]) : null;
  }

  async findEmployeeById(employeeId: string): Promise<Employee | null> {
    const res = await this.executor.query<RawEmployeeRow>(
      `
        SELECT e.id, e.user_id, u.email, u.role, e.external_ref, e.name, e.status, u.is_active, e.created_at
        FROM employees e
        JOIN users u ON u.id = e.user_id
        WHERE e.id = $1
      `,
      [employeeId],
    );
    return res.rows[0] ? mapEmployeeRow(res.rows[0]) : null;
  }

  async createUserAndEmployee(input: CreateUserEmployeeInput): Promise<Employee> {
    const now = new Date().toISOString();
    await this.executor.withTransaction(async (tx) => {
      await tx.query(
        `
          INSERT INTO users (id, email, password_hash, role, is_active, is_demo, must_change_password, created_at)
          VALUES ($1, $2, $3, $4, TRUE, FALSE, FALSE, $5)
        `,
        [input.userId, input.email.trim().toLowerCase(), input.passwordHash, input.role, now],
      );
      await tx.query(
        `
          INSERT INTO employees (id, user_id, external_ref, name, status, created_at)
          VALUES ($1, $2, $3, $4, 'active', $5)
        `,
        [input.employeeId, input.userId, input.externalRef, input.name.trim(), now],
      );
    });

    const created = await this.findEmployeeById(input.employeeId);
    if (!created) throw new Error('Error al recuperar el empleado creado');
    return created;
  }

  async updateEmployee(employeeId: string, input: UpdateEmployeeInput): Promise<Employee | null> {
    const existing = await this.findEmployeeById(employeeId);
    if (!existing) return null;

    await this.executor.withTransaction(async (tx) => {
      const nextName = input.name !== undefined ? input.name.trim() : existing.name;
      const nextRef = input.externalRef !== undefined ? input.externalRef : existing.externalRef;
      const nextStatus = input.status !== undefined ? input.status : existing.status;

      await tx.query(
        `UPDATE employees SET name = $1, external_ref = $2, status = $3 WHERE id = $4`,
        [nextName, nextRef, nextStatus, employeeId],
      );

      if (input.isUserActive !== undefined) {
        await tx.query(`UPDATE users SET is_active = $1 WHERE id = $2`, [
          input.isUserActive,
          existing.userId,
        ]);
      }
    });

    return this.findEmployeeById(employeeId);
  }

  async listBreakTypes(activeOnly: boolean = false): Promise<BreakType[]> {
    const sql = activeOnly
      ? 'SELECT id, code, name, is_paid, is_active FROM break_types WHERE is_active = TRUE ORDER BY name ASC'
      : 'SELECT id, code, name, is_paid, is_active FROM break_types ORDER BY name ASC';
    const res = await this.executor.query<{
      id: string;
      code: string;
      name: string;
      is_paid: boolean;
      is_active: boolean;
    }>(sql);

    return res.rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      isPaid: Boolean(r.is_paid),
      isActive: Boolean(r.is_active),
    }));
  }

  async createBreakType(input: CreateBreakTypeInput): Promise<BreakType> {
    const now = new Date().toISOString();
    const code = input.code.trim().toUpperCase();
    const name = input.name.trim();
    await this.executor.query(
      `
        INSERT INTO break_types (id, code, name, is_paid, is_active, created_at)
        VALUES ($1, $2, $3, $4, TRUE, $5)
      `,
      [input.id, code, name, input.isPaid, now],
    );

    return {
      id: input.id,
      code,
      name,
      isPaid: input.isPaid,
      isActive: true,
    };
  }

  async updateBreakType(id: string, input: UpdateBreakTypeInput): Promise<BreakType | null> {
    const existingRes = await this.executor.query<{
      id: string;
      code: string;
      name: string;
      is_paid: boolean;
      is_active: boolean;
    }>('SELECT id, code, name, is_paid, is_active FROM break_types WHERE id = $1', [id]);
    const row = existingRes.rows[0];
    if (!row) return null;

    const nextName = input.name !== undefined ? input.name.trim() : row.name;
    const nextPaid = input.isPaid !== undefined ? input.isPaid : Boolean(row.is_paid);
    const nextActive = input.isActive !== undefined ? input.isActive : Boolean(row.is_active);

    await this.executor.query(
      'UPDATE break_types SET name = $1, is_paid = $2, is_active = $3 WHERE id = $4',
      [nextName, nextPaid, nextActive, id],
    );

    return {
      id: row.id,
      code: row.code,
      name: nextName,
      isPaid: nextPaid,
      isActive: nextActive,
    };
  }

  async listClockEvents(filter: ListClockEventsFilter = {}): Promise<ClockEvent[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.employeeId) {
      params.push(filter.employeeId);
      clauses.push(`ce.employee_id = $${params.length}`);
    }
    if (filter.syncStatus === 'confirmado') {
      clauses.push('sa.id IS NOT NULL');
    } else if (filter.syncStatus === 'enviado') {
      clauses.push('sa.id IS NULL');
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    let limitClause = '';
    if (filter.limit) {
      params.push(filter.limit);
      limitClause = `LIMIT $${params.length}`;
    }

    const res = await this.executor.query<RawClockEventRow>(
      `
        SELECT
          ce.id,
          ce.employee_id,
          ce.type,
          ce.break_type_id,
          ce.received_at,
          ce.device_declared_at,
          ce.device_offset_ms,
          ce.time_source,
          ce.source,
          ce.corrects_event_id,
          ce.correction_id,
          ce.assignment_ref,
          ce.project_ref,
          ce.facility_ref,
          sa.mita_ack_ref
        FROM clock_events ce
        LEFT JOIN sync_acknowledgements sa ON sa.event_id = ce.id
        ${where}
        ORDER BY ce.device_declared_at ASC, ce.received_at ASC
        ${limitClause}
      `,
      params,
    );

    return res.rows.map(mapClockEventRow);
  }

  async findClockEventById(id: string): Promise<ClockEvent | null> {
    const res = await this.executor.query<RawClockEventRow>(
      `
        SELECT
          ce.id,
          ce.employee_id,
          ce.type,
          ce.break_type_id,
          ce.received_at,
          ce.device_declared_at,
          ce.device_offset_ms,
          ce.time_source,
          ce.source,
          ce.corrects_event_id,
          ce.correction_id,
          ce.assignment_ref,
          ce.project_ref,
          ce.facility_ref,
          sa.mita_ack_ref
        FROM clock_events ce
        LEFT JOIN sync_acknowledgements sa ON sa.event_id = ce.id
        WHERE ce.id = $1
      `,
      [id],
    );
    return res.rows[0] ? mapClockEventRow(res.rows[0]) : null;
  }

  async insertClockEvent(input: InsertClockEventInput): Promise<InsertClockEventResult> {
    const existing = await this.findClockEventById(input.id);
    if (existing) {
      return { event: existing, deduplicated: true };
    }

    await insertClockEventOnRunner(this.executor, input);
    const created = await this.findClockEventById(input.id);
    if (!created) throw new Error('Error al insertar clock_event');
    return { event: created, deduplicated: false };
  }

  async listMitaExportEvents(status?: SyncStatus, limit: number = 100): Promise<MitaExportEvent[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (status === 'confirmado') {
      clauses.push('sa.id IS NOT NULL');
    } else if (status === 'enviado') {
      clauses.push('sa.id IS NULL');
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);

    const res = await this.executor.query<{
      event_id: string;
      employee_id: string;
      employee_external_ref: string | null;
      employee_name: string;
      type: ClockEventType;
      source: EventSource;
      corrects_event_id: string | null;
      break_type_code: string | null;
      received_at_utc: unknown;
      device_declared_at_utc: unknown;
      device_offset_ms: number;
      time_source: TimeSource;
      assignment_ref: string | null;
      project_ref: string | null;
      facility_ref: string | null;
      mita_ack_ref: string | null;
    }>(
      `
        SELECT
          ce.id AS event_id,
          ce.employee_id,
          e.external_ref AS employee_external_ref,
          e.name AS employee_name,
          ce.type,
          ce.source,
          ce.corrects_event_id,
          bt.code AS break_type_code,
          ce.received_at AS received_at_utc,
          ce.device_declared_at AS device_declared_at_utc,
          ce.device_offset_ms,
          ce.time_source,
          ce.assignment_ref,
          ce.project_ref,
          ce.facility_ref,
          sa.mita_ack_ref
        FROM clock_events ce
        JOIN employees e ON e.id = ce.employee_id
        LEFT JOIN break_types bt ON bt.id = ce.break_type_id
        LEFT JOIN sync_acknowledgements sa ON sa.event_id = ce.id
        ${where}
        ORDER BY ce.received_at ASC
        LIMIT $1
      `,
      params,
    );

    return res.rows.map((r) => ({
      ...r,
      received_at_utc: toUtcIso(r.received_at_utc),
      device_declared_at_utc: toUtcIso(r.device_declared_at_utc),
      sync_status: r.mita_ack_ref ? 'confirmado' : 'enviado',
    }));
  }

  async acknowledgeEvents(
    eventIds: string[],
    mitaAckRef: string,
    confirmedAtUtc: string,
  ): Promise<number> {
    if (eventIds.length === 0) return 0;

    return this.executor.withTransaction(async (tx) => {
      let count = 0;
      for (const eventId of eventIds) {
        const existsRes = await tx.query('SELECT 1 FROM clock_events WHERE id = $1', [eventId]);
        if (existsRes.rows.length === 0) continue;
        const ackId = crypto.randomUUID();
        const ins = await tx.query(
          `
            INSERT INTO sync_acknowledgements (id, event_id, mita_ack_ref, confirmed_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (event_id) DO NOTHING
          `,
          [ackId, eventId, mitaAckRef, confirmedAtUtc],
        );
        if (ins.rowCount > 0) count += 1;
      }
      return count;
    });
  }

  async createCorrection(
    input: CreateCorrectionInput,
  ): Promise<{ correction: CorrectionRequest; deduplicated: boolean }> {
    if (input.idempotencyKey) {
      const existing = await this.findCorrectionByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        return { correction: existing, deduplicated: true };
      }
    }

    await this.executor.query(
      `
        INSERT INTO corrections (
          id, employee_id, target_event_id, kind, requested_by,
          reason, proposed_change_json, preview_json, status,
          idempotency_key, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)
      `,
      [
        input.id,
        input.employeeId,
        input.targetEventId,
        input.kind,
        input.requestedBy,
        input.reason,
        JSON.stringify(input.proposedChange),
        JSON.stringify(input.preview),
        input.idempotencyKey,
        input.createdAt,
      ],
    );

    const created = await this.findCorrectionById(input.id);
    if (!created) throw new Error('Error al recuperar la corrección creada');
    return { correction: created, deduplicated: false };
  }

  async findCorrectionById(id: string): Promise<CorrectionRequest | null> {
    const res = await this.executor.query<RawCorrectionRow>(
      `
        SELECT
          c.*,
          e.name AS employee_name,
          req_u.email AS requested_by_email,
          req_e.name AS requested_by_name,
          res_u.email AS resolved_by_email,
          res_e.name AS resolved_by_name
        FROM corrections c
        JOIN employees e ON e.id = c.employee_id
        JOIN users req_u ON req_u.id = c.requested_by
        LEFT JOIN employees req_e ON req_e.user_id = req_u.id
        LEFT JOIN users res_u ON res_u.id = c.resolved_by
        LEFT JOIN employees res_e ON res_e.user_id = res_u.id
        WHERE c.id = $1
      `,
      [id],
    );
    const row = res.rows[0];
    if (!row) return null;
    const targetEvent = row.target_event_id
      ? await this.findClockEventById(row.target_event_id)
      : null;
    return mapCorrectionRow(row, targetEvent);
  }

  async findCorrectionByIdempotencyKey(key: string): Promise<CorrectionRequest | null> {
    const res = await this.executor.query<{ id: string }>(
      'SELECT id FROM corrections WHERE idempotency_key = $1',
      [key],
    );
    if (!res.rows[0]) return null;
    return this.findCorrectionById(res.rows[0].id);
  }

  async listCorrections(filter: ListCorrectionsFilter = {}): Promise<CorrectionRequest[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.employeeId) {
      params.push(filter.employeeId);
      clauses.push(`c.employee_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      clauses.push(`c.status = $${params.length}`);
    }
    if (filter.kind) {
      params.push(filter.kind);
      clauses.push(`c.kind = $${params.length}`);
    }
    if (filter.fromDate) {
      params.push(filter.fromDate);
      clauses.push(`(c.created_at AT TIME ZONE 'UTC')::date >= $${params.length}::date`);
    }
    if (filter.toDate) {
      params.push(filter.toDate);
      clauses.push(`(c.created_at AT TIME ZONE 'UTC')::date <= $${params.length}::date`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const res = await this.executor.query<RawCorrectionRow>(
      `
        SELECT
          c.*,
          e.name AS employee_name,
          req_u.email AS requested_by_email,
          req_e.name AS requested_by_name,
          res_u.email AS resolved_by_email,
          res_e.name AS resolved_by_name
        FROM corrections c
        JOIN employees e ON e.id = c.employee_id
        JOIN users req_u ON req_u.id = c.requested_by
        LEFT JOIN employees req_e ON req_e.user_id = req_u.id
        LEFT JOIN users res_u ON res_u.id = c.resolved_by
        LEFT JOIN employees res_e ON res_e.user_id = res_u.id
        ${where}
        ORDER BY c.created_at DESC
      `,
      params,
    );

    const result: CorrectionRequest[] = [];
    for (const r of res.rows) {
      const targetEvent = r.target_event_id ? await this.findClockEventById(r.target_event_id) : null;
      result.push(mapCorrectionRow(r, targetEvent));
    }
    return result;
  }

  async cancelCorrection(id: string, resolvedAtUtc: string): Promise<CorrectionRequest | null> {
    const res = await this.executor.query(
      `
        UPDATE corrections
        SET status = 'cancelled', resolved_at = $1
        WHERE id = $2 AND status = 'pending'
      `,
      [resolvedAtUtc, id],
    );
    if (res.rowCount === 0) return null;
    return this.findCorrectionById(id);
  }

  async rejectCorrection(
    id: string,
    resolvedBy: string,
    resolutionNote: string,
    resolvedAtUtc: string,
  ): Promise<CorrectionRequest | null> {
    const res = await this.executor.query(
      `
        UPDATE corrections
        SET status = 'rejected', resolved_by = $1, resolution_note = $2, resolved_at = $3
        WHERE id = $4 AND status = 'pending'
      `,
      [resolvedBy, resolutionNote, resolvedAtUtc, id],
    );
    if (res.rowCount === 0) return null;
    return this.findCorrectionById(id);
  }

  async approveCorrectionAtomic(
    input: ApproveCorrectionAtomicInput,
  ): Promise<ApproveCorrectionAtomicResult> {
    const { insertedEventIds, deduplicated } = await this.executor.withTransaction(async (tx) => {
      const res = await tx.query<{
        id: string;
        employee_id: string;
        status: CorrectionStatus;
        approval_idempotency_key: string | null;
      }>(
        'SELECT id, employee_id, status, approval_idempotency_key FROM corrections WHERE id = $1 FOR UPDATE',
        [input.correctionId],
      );
      const row = res.rows[0];
      if (!row) {
        throw new Error('CORRECTION_NOT_FOUND');
      }

      if (row.status !== 'pending') {
        if (
          row.status === 'approved' &&
          input.approvalIdempotencyKey &&
          row.approval_idempotency_key === input.approvalIdempotencyKey
        ) {
          return { insertedEventIds: [] as string[], deduplicated: true };
        }
        throw new Error('CORRECTION_ALREADY_RESOLVED');
      }

      const ids: string[] = [];
      for (const ev of input.compensatingEvents) {
        await insertClockEventOnRunner(tx, ev);
        ids.push(ev.id);
      }

      await tx.query(
        `
          UPDATE corrections
          SET status = 'approved',
              resolved_by = $1,
              resolved_at = $2,
              resolution_note = $3,
              approval_idempotency_key = $4
          WHERE id = $5 AND status = 'pending'
        `,
        [
          input.resolvedByUserId,
          input.resolvedAtUtc,
          input.resolutionNote,
          input.approvalIdempotencyKey,
          input.correctionId,
        ],
      );

      return { insertedEventIds: ids, deduplicated: false };
    });

    const correction = await this.findCorrectionById(input.correctionId);
    if (!correction) throw new Error('CORRECTION_NOT_FOUND');

    const insertedEvents: ClockEvent[] = [];
    for (const id of insertedEventIds) {
      const ev = await this.findClockEventById(id);
      if (ev) insertedEvents.push(ev);
    }

    if (deduplicated) {
      const outRes = await this.executor.query<RawOutboxRow>(
        'SELECT * FROM mita_outbox WHERE correction_id = $1',
        [input.correctionId],
      );
      return {
        correction,
        insertedEvents: [],
        outboxItem: outRes.rows[0] ? mapOutboxRow(outRes.rows[0]) : null,
        deduplicated: true,
      };
    }

    const existingSessions = await this.listWorkSessions(correction.employeeId);
    const existingById = new Map(existingSessions.map((s) => [s.id, s]));
    const allEvents = await this.listClockEvents({ employeeId: correction.employeeId });
    const sessions = input.recomputeSessions(allEvents, existingById);
    await this.replaceEmployeeWorkSessions(correction.employeeId, sessions);
    const updatedSessions = await this.listWorkSessions(correction.employeeId);

    for (const s of updatedSessions) {
      if (s.status === 'closed' || s.status === 'voided') {
        await this.resolveIncidentsForSession(s.id, input.resolvedAtUtc, correction.id);
      }
    }

    const affectedSession =
      sessions.find((s) => s.madridDate === correction.preview.madridDateKey) ??
      sessions[sessions.length - 1] ??
      null;

    const payload = input.buildOutboxPayload(insertedEvents, affectedSession);
    const idempotencyKey = `correction:${correction.id}`;
    const outboxId = crypto.randomUUID();
    await this.executor.query(
      `
        INSERT INTO mita_outbox (
          id, idempotency_key, kind, correction_id, payload_json, status, attempts, created_at
        ) VALUES ($1, $2, 'correction', $3, $4, 'pending', 0, $5)
        ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [outboxId, idempotencyKey, correction.id, JSON.stringify(payload), input.resolvedAtUtc],
    );

    const outboxRes = await this.executor.query<RawOutboxRow>(
      'SELECT * FROM mita_outbox WHERE idempotency_key = $1',
      [idempotencyKey],
    );

    return {
      correction,
      insertedEvents,
      outboxItem: outboxRes.rows[0] ? mapOutboxRow(outboxRes.rows[0]) : null,
      deduplicated: false,
    };
  }

  async replaceEmployeeWorkSessions(employeeId: string, sessions: WorkSession[]): Promise<void> {
    const now = new Date().toISOString();
    const activeIds = new Set(sessions.map((s) => s.id));

    await this.executor.withTransaction(async (tx) => {
      const existingRes = await tx.query<{ id: string }>(
        'SELECT id FROM work_sessions WHERE employee_id = $1',
        [employeeId],
      );

      for (const row of existingRes.rows) {
        if (!activeIds.has(row.id)) {
          await tx.query(
            `
              UPDATE work_sessions
              SET status = 'voided', worked_minutes = 0, raw_worked_minutes = 0, break_minutes = 0,
                  is_provisional_cap = FALSE, delta_minutes = -planned_minutes, updated_at = $1
              WHERE id = $2
            `,
            [now, row.id],
          );
        }
      }

      for (const s of sessions) {
        await tx.query(
          `
            INSERT INTO work_sessions (
              id, employee_id, madrid_date, start_utc, end_utc, status,
              worked_minutes, raw_worked_minutes, planned_minutes, delta_minutes, break_minutes,
              planned_shift_id, planned_end_utc, is_provisional_cap,
              overrun_acknowledged, overrun_reason, overrun_acknowledged_at,
              anomaly_flags_json, has_pending_correction, has_approved_correction, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
            ON CONFLICT(id) DO UPDATE SET
              madrid_date = EXCLUDED.madrid_date,
              start_utc = EXCLUDED.start_utc,
              end_utc = EXCLUDED.end_utc,
              status = EXCLUDED.status,
              worked_minutes = EXCLUDED.worked_minutes,
              raw_worked_minutes = EXCLUDED.raw_worked_minutes,
              planned_minutes = EXCLUDED.planned_minutes,
              delta_minutes = EXCLUDED.delta_minutes,
              break_minutes = EXCLUDED.break_minutes,
              planned_shift_id = EXCLUDED.planned_shift_id,
              planned_end_utc = EXCLUDED.planned_end_utc,
              is_provisional_cap = EXCLUDED.is_provisional_cap,
              overrun_acknowledged = (work_sessions.overrun_acknowledged OR EXCLUDED.overrun_acknowledged),
              overrun_reason = COALESCE(work_sessions.overrun_reason, EXCLUDED.overrun_reason),
              overrun_acknowledged_at = COALESCE(work_sessions.overrun_acknowledged_at, EXCLUDED.overrun_acknowledged_at),
              anomaly_flags_json = EXCLUDED.anomaly_flags_json,
              has_pending_correction = EXCLUDED.has_pending_correction,
              has_approved_correction = EXCLUDED.has_approved_correction,
              updated_at = EXCLUDED.updated_at
          `,
          [
            s.id,
            s.employeeId,
            s.madridDate,
            s.startUtc,
            s.endUtc,
            s.status,
            s.workedMinutes,
            s.rawWorkedMinutes ?? s.workedMinutes,
            s.plannedMinutes,
            s.deltaMinutes,
            s.breakMinutes,
            s.plannedShiftId ?? null,
            s.plannedEndUtc ?? null,
            Boolean(s.isProvisionalCap),
            Boolean(s.overrunAcknowledged),
            s.overrunReason ?? null,
            s.overrunAcknowledgedAt ?? null,
            JSON.stringify(s.anomalyFlags),
            Boolean(s.hasPendingCorrection),
            Boolean(s.hasApprovedCorrection),
            s.updatedAt,
          ],
        );
      }
    });
  }

  async listWorkSessions(employeeId?: string): Promise<WorkSession[]> {
    const res = employeeId
      ? await this.executor.query<RawWorkSessionRow>(
          'SELECT * FROM work_sessions WHERE employee_id = $1 ORDER BY start_utc DESC',
          [employeeId],
        )
      : await this.executor.query<RawWorkSessionRow>(
          'SELECT * FROM work_sessions ORDER BY start_utc DESC',
        );
    return res.rows.map(mapWorkSessionRow);
  }

  async findWorkSessionById(sessionId: string): Promise<WorkSession | null> {
    const res = await this.executor.query<RawWorkSessionRow>(
      'SELECT * FROM work_sessions WHERE id = $1',
      [sessionId],
    );
    return res.rows[0] ? mapWorkSessionRow(res.rows[0]) : null;
  }

  async acknowledgeSessionOverrun(
    sessionId: string,
    reason: string,
    acknowledgedAtUtc: string,
  ): Promise<WorkSession | null> {
    const res = await this.executor.query(
      `
        UPDATE work_sessions
        SET overrun_acknowledged = TRUE, overrun_reason = $1, overrun_acknowledged_at = $2, updated_at = $3
        WHERE id = $4
      `,
      [reason, acknowledgedAtUtc, acknowledgedAtUtc, sessionId],
    );
    if (res.rowCount === 0) return null;
    return this.findWorkSessionById(sessionId);
  }

  async appendAuditLog(input: CreateAuditLogInput): Promise<AuditLogEntry> {
    await this.executor.query(
      `
        INSERT INTO audit_log (
          id, actor_user_id, action, entity_type, entity_id,
          details_json, ip_address, user_agent, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        input.id,
        input.actorUserId,
        input.action,
        input.entityType,
        input.entityId,
        JSON.stringify(input.details),
        input.ipAddress,
        input.userAgent,
        input.createdAt,
      ],
    );

    return {
      id: input.id,
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      details: input.details,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      createdAt: input.createdAt,
    };
  }

  async listAuditLog(limit: number = 100): Promise<AuditLogEntry[]> {
    const res = await this.executor.query<{
      id: string;
      actor_user_id: string;
      actor_email: string | null;
      action: string;
      entity_type: string;
      entity_id: string;
      details_json: string;
      ip_address: string;
      user_agent: string;
      created_at: unknown;
    }>(
      `
        SELECT a.*, u.email AS actor_email
        FROM audit_log a
        LEFT JOIN users u ON u.id = a.actor_user_id
        ORDER BY a.created_at DESC
        LIMIT $1
      `,
      [limit],
    );

    return res.rows.map((r) => ({
      id: r.id,
      actorUserId: r.actor_user_id,
      actorEmail: r.actor_email ?? undefined,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      details: JSON.parse(r.details_json) as Record<string, unknown>,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      createdAt: toUtcIso(r.created_at),
    }));
  }

  async listOutboxItems(status?: MitaOutboxItem['status']): Promise<MitaOutboxItem[]> {
    const res = status
      ? await this.executor.query<RawOutboxRow>(
          'SELECT * FROM mita_outbox WHERE status = $1 ORDER BY created_at ASC',
          [status],
        )
      : await this.executor.query<RawOutboxRow>(
          'SELECT * FROM mita_outbox ORDER BY created_at DESC',
        );
    return res.rows.map(mapOutboxRow);
  }

  async markOutboxSent(id: string, externalAckRef: string, sentAtUtc: string): Promise<void> {
    await this.executor.query(
      `
        UPDATE mita_outbox
        SET status = 'sent', attempts = attempts + 1, external_ack_ref = $1, sent_at = $2, last_error = NULL
        WHERE id = $3
      `,
      [externalAckRef, sentAtUtc, id],
    );
  }

  async markOutboxFailed(id: string, errorMessage: string): Promise<void> {
    await this.executor.query(
      `
        UPDATE mita_outbox
        SET status = 'failed', attempts = attempts + 1, last_error = $1
        WHERE id = $2
      `,
      [errorMessage, id],
    );
  }

  async listPlannedShifts(filter: ListPlannedShiftsFilter = {}): Promise<PlannedShift[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.employeeId) {
      params.push(filter.employeeId);
      clauses.push(`ps.employee_id = $${params.length}`);
    }
    if (filter.fromDate) {
      params.push(filter.fromDate);
      clauses.push(`ps.madrid_date >= $${params.length}`);
    }
    if (filter.toDate) {
      params.push(filter.toDate);
      clauses.push(`ps.madrid_date <= $${params.length}`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const res = await this.executor.query<RawPlannedShiftRow>(
      `
        SELECT ps.*, e.name AS employee_name
        FROM planned_shifts ps
        JOIN employees e ON e.id = ps.employee_id
        ${where}
        ORDER BY ps.start_utc ASC
      `,
      params,
    );
    return res.rows.map(mapPlannedShiftRow);
  }

  async findPlannedShiftById(id: string): Promise<PlannedShift | null> {
    const res = await this.executor.query<RawPlannedShiftRow>(
      `
        SELECT ps.*, e.name AS employee_name
        FROM planned_shifts ps
        JOIN employees e ON e.id = ps.employee_id
        WHERE ps.id = $1
      `,
      [id],
    );
    return res.rows[0] ? mapPlannedShiftRow(res.rows[0]) : null;
  }

  async createPlannedShift(input: CreatePlannedShiftInput): Promise<PlannedShift> {
    await this.executor.query(
      `
        INSERT INTO planned_shifts (
          id, employee_id, madrid_date, start_utc, end_utc,
          planned_break_minutes, planned_minutes, project_ref, facility_ref,
          assignment_ref, source, template_id, label, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `,
      [
        input.id,
        input.employeeId,
        input.madridDateKey,
        input.startUtc,
        input.endUtc,
        input.plannedBreakMinutes,
        input.plannedMinutes,
        input.projectRef,
        input.facilityRef,
        input.assignmentRef,
        input.source,
        input.templateId ?? null,
        input.label,
        input.createdAt,
        input.createdAt,
      ],
    );

    const created = await this.findPlannedShiftById(input.id);
    if (!created) throw new Error('Error al recuperar la jornada planificada');
    return created;
  }

  async updatePlannedShift(id: string, input: UpdatePlannedShiftInput): Promise<PlannedShift | null> {
    const res = await this.executor.query(
      `
        UPDATE planned_shifts
        SET madrid_date = $1, start_utc = $2, end_utc = $3,
            planned_break_minutes = $4, planned_minutes = $5,
            project_ref = $6, facility_ref = $7, assignment_ref = $8,
            label = $9, updated_at = $10
        WHERE id = $11
      `,
      [
        input.madridDateKey,
        input.startUtc,
        input.endUtc,
        input.plannedBreakMinutes,
        input.plannedMinutes,
        input.projectRef,
        input.facilityRef,
        input.assignmentRef,
        input.label,
        input.updatedAt,
        id,
      ],
    );
    if (res.rowCount === 0) return null;
    return this.findPlannedShiftById(id);
  }

  async deletePlannedShift(id: string): Promise<boolean> {
    const res = await this.executor.query('DELETE FROM planned_shifts WHERE id = $1', [id]);
    return res.rowCount > 0;
  }

  async listShiftTemplates(employeeId?: string): Promise<ShiftTemplate[]> {
    const res = employeeId
      ? await this.executor.query<RawShiftTemplateRow>(
          `
            SELECT st.*, e.name AS employee_name
            FROM shift_templates st
            JOIN employees e ON e.id = st.employee_id
            WHERE st.employee_id = $1
            ORDER BY st.created_at DESC
          `,
          [employeeId],
        )
      : await this.executor.query<RawShiftTemplateRow>(`
          SELECT st.*, e.name AS employee_name
          FROM shift_templates st
          JOIN employees e ON e.id = st.employee_id
          ORDER BY e.name ASC, st.created_at DESC
        `);

    return res.rows.map(mapShiftTemplateRow);
  }

  async findShiftTemplateById(id: string): Promise<ShiftTemplate | null> {
    const res = await this.executor.query<RawShiftTemplateRow>(
      `
        SELECT st.*, e.name AS employee_name
        FROM shift_templates st
        JOIN employees e ON e.id = st.employee_id
        WHERE st.id = $1
      `,
      [id],
    );
    return res.rows[0] ? mapShiftTemplateRow(res.rows[0]) : null;
  }

  async createShiftTemplate(input: CreateShiftTemplateInput): Promise<ShiftTemplate> {
    await this.executor.query(
      `
        INSERT INTO shift_templates (
          id, employee_id, name, weekdays_json, start_time_madrid, end_time_madrid,
          crosses_midnight, planned_break_minutes, project_ref, facility_ref,
          valid_from, valid_to, is_active, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `,
      [
        input.id,
        input.employeeId,
        input.name,
        JSON.stringify(input.weekdays),
        input.startTimeMadrid,
        input.endTimeMadrid,
        Boolean(input.crossesMidnight),
        input.plannedBreakMinutes,
        input.projectRef,
        input.facilityRef,
        input.validFrom,
        input.validTo,
        Boolean(input.isActive),
        input.createdAt,
        input.createdAt,
      ],
    );

    const created = await this.findShiftTemplateById(input.id);
    if (!created) throw new Error('Error al recuperar la plantilla creada');
    return created;
  }

  async updateShiftTemplate(
    id: string,
    input: UpdateShiftTemplateInput,
  ): Promise<ShiftTemplate | null> {
    const existing = await this.findShiftTemplateById(id);
    if (!existing) return null;

    await this.executor.query(
      `
        UPDATE shift_templates
        SET name = $1, weekdays_json = $2, start_time_madrid = $3, end_time_madrid = $4,
            crosses_midnight = $5, planned_break_minutes = $6, project_ref = $7, facility_ref = $8,
            valid_from = $9, valid_to = $10, is_active = $11, updated_at = $12
        WHERE id = $13
      `,
      [
        input.name ?? existing.name,
        JSON.stringify(input.weekdays ?? existing.weekdays),
        input.startTimeMadrid ?? existing.startTimeMadrid,
        input.endTimeMadrid ?? existing.endTimeMadrid,
        Boolean(input.crossesMidnight ?? existing.crossesMidnight),
        input.plannedBreakMinutes ?? existing.plannedBreakMinutes,
        input.projectRef !== undefined ? input.projectRef : existing.projectRef,
        input.facilityRef !== undefined ? input.facilityRef : existing.facilityRef,
        input.validFrom ?? existing.validFrom,
        input.validTo !== undefined ? input.validTo : existing.validTo,
        Boolean(input.isActive ?? existing.isActive),
        input.updatedAt,
        id,
      ],
    );

    return this.findShiftTemplateById(id);
  }

  async deleteShiftTemplate(id: string): Promise<boolean> {
    const res = await this.executor.query('DELETE FROM shift_templates WHERE id = $1', [id]);
    return res.rowCount > 0;
  }

  async listDayOffs(
    filter: { employeeId?: string; fromDate?: string; toDate?: string } = {},
  ): Promise<DayOff[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.employeeId) {
      params.push(filter.employeeId);
      clauses.push(`(d.employee_id = $${params.length} OR d.employee_id IS NULL)`);
    }
    if (filter.fromDate) {
      params.push(filter.fromDate);
      clauses.push(`d.madrid_date >= $${params.length}`);
    }
    if (filter.toDate) {
      params.push(filter.toDate);
      clauses.push(`d.madrid_date <= $${params.length}`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const res = await this.executor.query<RawDayOffRow>(
      `
        SELECT d.*, e.name AS employee_name
        FROM day_offs d
        LEFT JOIN employees e ON e.id = d.employee_id
        ${where}
        ORDER BY d.madrid_date DESC
      `,
      params,
    );

    return res.rows.map((r) => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      madridDate: r.madrid_date,
      type: r.type,
      note: r.note,
      createdAt: toUtcIso(r.created_at),
    }));
  }

  async findDayOffById(id: string): Promise<DayOff | null> {
    const res = await this.executor.query<RawDayOffRow>(
      `
        SELECT d.*, e.name AS employee_name
        FROM day_offs d
        LEFT JOIN employees e ON e.id = d.employee_id
        WHERE d.id = $1
      `,
      [id],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      employeeId: row.employee_id,
      employeeName: row.employee_name,
      madridDate: row.madrid_date,
      type: row.type,
      note: row.note,
      createdAt: toUtcIso(row.created_at),
    };
  }

  async createDayOff(input: CreateDayOffInput): Promise<DayOff> {
    await this.executor.query(
      `
        INSERT INTO day_offs (id, employee_id, madrid_date, type, note, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [input.id, input.employeeId, input.madridDate, input.type, input.note, input.createdAt],
    );
    const created = await this.findDayOffById(input.id);
    if (!created) throw new Error('Error al recuperar día libre');
    return created;
  }

  async deleteDayOff(id: string): Promise<boolean> {
    const res = await this.executor.query('DELETE FROM day_offs WHERE id = $1', [id]);
    return res.rowCount > 0;
  }

  async getClockPolicy(): Promise<ClockPolicy> {
    const res = await this.executor.query<RawClockPolicyRow>(
      'SELECT * FROM clock_policies WHERE id = $1',
      ['default'],
    );
    const row = res.rows[0];
    if (!row) {
      return {
        id: 'default',
        pastPlannedEndMinutes: 15,
        flagAfterEndMinutes: 120,
        maxOpenHours: 12,
        maxDailyMinutes: 720,
        scheduleToleranceMinutes: 30,
        overrunPolicy: 'flag_only',
        requirePlannedShift: false,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      id: row.id,
      pastPlannedEndMinutes: row.past_planned_end_minutes,
      flagAfterEndMinutes: row.flag_after_end_minutes,
      maxOpenHours: row.max_open_hours,
      maxDailyMinutes: row.max_daily_minutes,
      scheduleToleranceMinutes: row.schedule_tolerance_minutes,
      overrunPolicy: row.overrun_policy,
      requirePlannedShift: Boolean(row.require_planned_shift),
      updatedAt: toUtcIso(row.updated_at),
    };
  }

  async updateClockPolicy(input: UpdateClockPolicyInput): Promise<ClockPolicy> {
    const cur = await this.getClockPolicy();
    await this.executor.query(
      `
        UPDATE clock_policies
        SET past_planned_end_minutes = $1,
            flag_after_end_minutes = $2,
            max_open_hours = $3,
            max_daily_minutes = $4,
            schedule_tolerance_minutes = $5,
            overrun_policy = $6,
            require_planned_shift = $7,
            updated_at = $8
        WHERE id = 'default'
      `,
      [
        input.pastPlannedEndMinutes ?? cur.pastPlannedEndMinutes,
        input.flagAfterEndMinutes ?? cur.flagAfterEndMinutes,
        input.maxOpenHours ?? cur.maxOpenHours,
        input.maxDailyMinutes ?? cur.maxDailyMinutes,
        input.scheduleToleranceMinutes ?? cur.scheduleToleranceMinutes,
        input.overrunPolicy ?? cur.overrunPolicy,
        Boolean(input.requirePlannedShift ?? cur.requirePlannedShift),
        input.updatedAt,
      ],
    );
    return this.getClockPolicy();
  }

  async upsertSessionIncident(input: UpsertSessionIncidentInput): Promise<SessionIncident> {
    const existingRes = await this.executor.query<RawIncidentRow>(
      `
        SELECT si.*, e.name AS employee_name
        FROM session_incidents si
        JOIN employees e ON e.id = si.employee_id
        WHERE si.session_id = $1 AND si.status <> 'resolved'
        ORDER BY si.detected_at DESC
        LIMIT 1
      `,
      [input.sessionId],
    );
    const existing = existingRes.rows[0];

    if (existing) {
      if (existing.kind !== input.kind) {
        await this.executor.query('UPDATE session_incidents SET kind = $1 WHERE id = $2', [
          input.kind,
          existing.id,
        ]);
      }
      const updatedRes = await this.executor.query<RawIncidentRow>(
        `
          SELECT si.*, e.name AS employee_name
          FROM session_incidents si
          JOIN employees e ON e.id = si.employee_id
          WHERE si.id = $1
        `,
        [existing.id],
      );
      return mapIncidentRow(updatedRes.rows[0]);
    }

    await this.executor.query(
      `
        INSERT INTO session_incidents (
          id, session_id, employee_id, kind, status, madrid_date,
          shift_start_utc, planned_end_utc, detected_at
        ) VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8)
      `,
      [
        input.id,
        input.sessionId,
        input.employeeId,
        input.kind,
        input.madridDate,
        input.shiftStartUtc,
        input.plannedEndUtc,
        input.detectedAt,
      ],
    );

    const createdRes = await this.executor.query<RawIncidentRow>(
      `
        SELECT si.*, e.name AS employee_name
        FROM session_incidents si
        JOIN employees e ON e.id = si.employee_id
        WHERE si.id = $1
      `,
      [input.id],
    );
    return mapIncidentRow(createdRes.rows[0]);
  }

  async listSessionIncidents(status?: IncidentStatus): Promise<SessionIncident[]> {
    const res = status
      ? await this.executor.query<RawIncidentRow>(
          `
            SELECT si.*, e.name AS employee_name
            FROM session_incidents si
            JOIN employees e ON e.id = si.employee_id
            WHERE si.status = $1
            ORDER BY si.detected_at DESC
          `,
          [status],
        )
      : await this.executor.query<RawIncidentRow>(`
          SELECT si.*, e.name AS employee_name
          FROM session_incidents si
          JOIN employees e ON e.id = si.employee_id
          ORDER BY si.detected_at DESC
        `);

    return res.rows.map(mapIncidentRow);
  }

  async acknowledgeIncident(
    id: string,
    userId: string,
    acknowledgedAtUtc: string,
  ): Promise<SessionIncident | null> {
    const res = await this.executor.query(
      `
        UPDATE session_incidents
        SET status = 'acknowledged', acknowledged_by = $1, acknowledged_at = $2
        WHERE id = $3 AND status = 'open'
      `,
      [userId, acknowledgedAtUtc, id],
    );
    if (res.rowCount === 0) return null;

    const rowRes = await this.executor.query<RawIncidentRow>(
      `
        SELECT si.*, e.name AS employee_name
        FROM session_incidents si
        JOIN employees e ON e.id = si.employee_id
        WHERE si.id = $1
      `,
      [id],
    );
    return rowRes.rows[0] ? mapIncidentRow(rowRes.rows[0]) : null;
  }

  async resolveIncidentsForSession(
    sessionId: string,
    resolvedAtUtc: string,
    correctionId: string | null = null,
  ): Promise<void> {
    await this.executor.query(
      `
        UPDATE session_incidents
        SET status = 'resolved',
            resolved_at = $1,
            resolved_by_correction_id = COALESCE($2, resolved_by_correction_id)
        WHERE session_id = $3 AND status <> 'resolved'
      `,
      [resolvedAtUtc, correctionId, sessionId],
    );
  }
}

async function insertClockEventOnRunner(
  runner: SqlRunner,
  input: InsertClockEventInput,
): Promise<void> {
  await runner.query(
    `
      INSERT INTO clock_events (
        id, employee_id, type, break_type_id, received_at,
        device_declared_at, device_offset_ms, time_source,
        source, corrects_event_id, correction_id,
        assignment_ref, project_ref, facility_ref
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `,
    [
      input.id,
      input.employeeId,
      input.type,
      input.breakTypeId,
      input.receivedAt,
      input.deviceDeclaredAt,
      input.deviceOffsetMs,
      input.timeSource,
      input.source ?? 'employee',
      input.correctsEventId ?? null,
      input.correctionId ?? null,
      input.assignmentRef,
      input.projectRef,
      input.facilityRef,
    ],
  );
}

function toUtcIso(val: unknown): string {
  if (val instanceof Date) return val.toISOString();
  return new Date(String(val)).toISOString();
}

function toNullableUtcIso(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  return toUtcIso(val);
}

interface RawEmployeeRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  email: string;
  role: UserRole;
  external_ref: string | null;
  name: string;
  status: 'active' | 'inactive';
  is_active: boolean;
  created_at: unknown;
}

function mapEmployeeRow(row: RawEmployeeRow): Employee {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    role: row.role,
    externalRef: row.external_ref,
    name: row.name,
    status: row.status,
    isUserActive: Boolean(row.is_active),
    createdAt: toUtcIso(row.created_at),
  };
}

interface RawClockEventRow extends Record<string, unknown> {
  id: string;
  employee_id: string;
  type: ClockEventType;
  break_type_id: string | null;
  received_at: unknown;
  device_declared_at: unknown;
  device_offset_ms: number;
  time_source: TimeSource;
  source: EventSource;
  corrects_event_id: string | null;
  correction_id: string | null;
  assignment_ref: string | null;
  project_ref: string | null;
  facility_ref: string | null;
  mita_ack_ref: string | null;
}

function mapClockEventRow(r: RawClockEventRow): ClockEvent {
  return {
    id: r.id,
    employeeId: r.employee_id,
    type: r.type,
    breakTypeId: r.break_type_id,
    receivedAt: toUtcIso(r.received_at),
    deviceDeclaredAt: toUtcIso(r.device_declared_at),
    deviceOffsetMs: Number(r.device_offset_ms),
    timeSource: r.time_source,
    source: r.source ?? 'employee',
    correctsEventId: r.corrects_event_id ?? null,
    correctionId: r.correction_id ?? null,
    assignmentRef: r.assignment_ref,
    projectRef: r.project_ref,
    facilityRef: r.facility_ref,
    syncStatus: r.mita_ack_ref ? 'confirmado' : 'enviado',
    mitaAckRef: r.mita_ack_ref,
  };
}

interface RawCorrectionRow extends Record<string, unknown> {
  id: string;
  employee_id: string;
  employee_name: string;
  target_event_id: string | null;
  kind: CorrectionKind;
  requested_by: string;
  requested_by_email: string;
  requested_by_name: string | null;
  reason: string;
  proposed_change_json: string;
  preview_json: string;
  status: CorrectionStatus;
  resolved_by: string | null;
  resolved_by_email: string | null;
  resolved_by_name: string | null;
  resolved_at: unknown;
  resolution_note: string | null;
  idempotency_key: string | null;
  created_at: unknown;
}

function mapCorrectionRow(r: RawCorrectionRow, targetEvent: ClockEvent | null): CorrectionRequest {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    targetEventId: r.target_event_id,
    targetEvent,
    kind: r.kind,
    requestedBy: r.requested_by,
    requestedByEmail: r.requested_by_email,
    requestedByName: r.requested_by_name ?? r.requested_by_email,
    reason: r.reason,
    proposedChange: JSON.parse(r.proposed_change_json) as ProposedCorrectionChange,
    preview: JSON.parse(r.preview_json) as CorrectionPreview,
    status: r.status,
    resolvedBy: r.resolved_by,
    resolvedByEmail: r.resolved_by_email,
    resolvedByName: r.resolved_by_name,
    resolvedAt: toNullableUtcIso(r.resolved_at),
    resolutionNote: r.resolution_note,
    idempotencyKey: r.idempotency_key,
    createdAt: toUtcIso(r.created_at),
  };
}

interface RawOutboxRow extends Record<string, unknown> {
  id: string;
  idempotency_key: string;
  kind: 'correction';
  correction_id: string;
  payload_json: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  last_error: string | null;
  external_ack_ref: string | null;
  created_at: unknown;
  sent_at: unknown;
}

function mapOutboxRow(r: RawOutboxRow): MitaOutboxItem {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    kind: r.kind,
    correctionId: r.correction_id,
    payload: JSON.parse(r.payload_json) as MitaCorrectionOutboxPayload,
    status: r.status,
    attempts: Number(r.attempts),
    lastError: r.last_error,
    externalAckRef: r.external_ack_ref,
    createdAt: toUtcIso(r.created_at),
    sentAt: toNullableUtcIso(r.sent_at),
  };
}

interface RawWorkSessionRow extends Record<string, unknown> {
  id: string;
  employee_id: string;
  madrid_date: string;
  start_utc: unknown;
  end_utc: unknown;
  status: WorkSessionStatus;
  worked_minutes: number;
  raw_worked_minutes: number;
  planned_minutes: number;
  delta_minutes: number;
  break_minutes: number;
  planned_shift_id: string | null;
  planned_end_utc: unknown;
  is_provisional_cap: boolean;
  overrun_acknowledged: boolean;
  overrun_reason: string | null;
  overrun_acknowledged_at: unknown;
  anomaly_flags_json: string;
  has_pending_correction: boolean;
  has_approved_correction: boolean;
  updated_at: unknown;
}

function mapWorkSessionRow(r: RawWorkSessionRow): WorkSession {
  return {
    id: r.id,
    employeeId: r.employee_id,
    madridDate: r.madrid_date,
    startUtc: toUtcIso(r.start_utc),
    endUtc: toNullableUtcIso(r.end_utc),
    status: r.status,
    workedMinutes: Number(r.worked_minutes),
    rawWorkedMinutes: Number(r.raw_worked_minutes ?? r.worked_minutes),
    plannedMinutes: Number(r.planned_minutes),
    deltaMinutes: Number(r.delta_minutes),
    breakMinutes: Number(r.break_minutes),
    plannedShiftId: r.planned_shift_id ?? null,
    plannedEndUtc: toNullableUtcIso(r.planned_end_utc),
    isProvisionalCap: Boolean(r.is_provisional_cap),
    overrunAcknowledged: Boolean(r.overrun_acknowledged),
    overrunReason: r.overrun_reason ?? null,
    overrunAcknowledgedAt: toNullableUtcIso(r.overrun_acknowledged_at),
    anomalyFlags: JSON.parse(r.anomaly_flags_json) as AnomalyFlag[],
    hasPendingCorrection: Boolean(r.has_pending_correction),
    hasApprovedCorrection: Boolean(r.has_approved_correction),
    updatedAt: toUtcIso(r.updated_at),
  };
}

interface RawPlannedShiftRow extends Record<string, unknown> {
  id: string;
  employee_id: string;
  employee_name: string;
  madrid_date: string;
  start_utc: unknown;
  end_utc: unknown;
  planned_break_minutes: number;
  planned_minutes: number;
  project_ref: string | null;
  facility_ref: string | null;
  assignment_ref: string | null;
  source: PlannedShiftSource;
  template_id: string | null;
  label: string;
  created_at: unknown;
  updated_at: unknown;
}

function mapPlannedShiftRow(r: RawPlannedShiftRow): PlannedShift {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    madridDateKey: r.madrid_date,
    startUtc: toUtcIso(r.start_utc),
    endUtc: toUtcIso(r.end_utc),
    plannedBreakMinutes: Number(r.planned_break_minutes),
    plannedMinutes: Number(r.planned_minutes),
    projectRef: r.project_ref,
    facilityRef: r.facility_ref,
    assignmentRef: r.assignment_ref,
    source: r.source,
    templateId: r.template_id,
    label: r.label,
    createdAt: toUtcIso(r.created_at),
    updatedAt: toUtcIso(r.updated_at),
  };
}

interface RawShiftTemplateRow extends Record<string, unknown> {
  id: string;
  employee_id: string;
  employee_name: string;
  name: string;
  weekdays_json: string;
  start_time_madrid: string;
  end_time_madrid: string;
  crosses_midnight: boolean;
  planned_break_minutes: number;
  project_ref: string | null;
  facility_ref: string | null;
  valid_from: string;
  valid_to: string | null;
  is_active: boolean;
  created_at: unknown;
  updated_at: unknown;
}

function mapShiftTemplateRow(r: RawShiftTemplateRow): ShiftTemplate {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    name: r.name,
    weekdays: JSON.parse(r.weekdays_json) as number[],
    startTimeMadrid: r.start_time_madrid,
    endTimeMadrid: r.end_time_madrid,
    crossesMidnight: Boolean(r.crosses_midnight),
    plannedBreakMinutes: Number(r.planned_break_minutes),
    projectRef: r.project_ref,
    facilityRef: r.facility_ref,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    isActive: Boolean(r.is_active),
    createdAt: toUtcIso(r.created_at),
    updatedAt: toUtcIso(r.updated_at),
  };
}

interface RawDayOffRow extends Record<string, unknown> {
  id: string;
  employee_id: string | null;
  employee_name: string | null;
  madrid_date: string;
  type: DayOffType;
  note: string | null;
  created_at: unknown;
}

interface RawClockPolicyRow extends Record<string, unknown> {
  id: string;
  past_planned_end_minutes: number;
  flag_after_end_minutes: number;
  max_open_hours: number;
  max_daily_minutes: number;
  schedule_tolerance_minutes: number;
  overrun_policy: OverrunPolicy;
  require_planned_shift: boolean;
  updated_at: unknown;
}

interface RawIncidentRow extends Record<string, unknown> {
  id: string;
  session_id: string;
  employee_id: string;
  employee_name: string;
  kind: IncidentKind;
  status: IncidentStatus;
  madrid_date: string;
  shift_start_utc: unknown;
  planned_end_utc: unknown;
  detected_at: unknown;
  acknowledged_at: unknown;
  acknowledged_by: string | null;
  resolved_at: unknown;
  resolved_by_correction_id: string | null;
}

function mapIncidentRow(r: RawIncidentRow): SessionIncident {
  return {
    id: r.id,
    sessionId: r.session_id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    kind: r.kind,
    status: r.status,
    madridDate: r.madrid_date,
    shiftStartUtc: toUtcIso(r.shift_start_utc),
    plannedEndUtc: toNullableUtcIso(r.planned_end_utc),
    detectedAt: toUtcIso(r.detected_at),
    acknowledgedAt: toNullableUtcIso(r.acknowledged_at),
    acknowledgedBy: r.acknowledged_by,
    resolvedAt: toNullableUtcIso(r.resolved_at),
    resolvedByCorrectionId: r.resolved_by_correction_id,
  };
}

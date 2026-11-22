import type {
  AuditLogEntry,
  BreakType,
  ClockEvent,
  ClockPolicy,
  CorrectionKind,
  CorrectionPreview,
  CorrectionRequest,
  CorrectionStatus,
  DayOff,
  DayOffType,
  DemoAccountInfo,
  Employee,
  IncidentKind,
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
  UserPublic,
  UserRecord,
  UserRole,
  WorkSession,
} from '../shared/types.ts';

export interface CreateUserEmployeeInput {
  userId: string;
  employeeId: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  name: string;
  externalRef: string | null;
}

export interface UpdateEmployeeInput {
  name?: string;
  email?: string;
  role?: UserRole;
  passwordHash?: string;
  externalRef?: string | null;
  status?: 'active' | 'inactive';
  isUserActive?: boolean;
}

export type DeleteEmployeeResult =
  | { deleted: true; employee: Employee }
  | { deleted: false; reason: 'not_found' | 'has_immutable_history' };

export interface CreateBreakTypeInput {
  id: string;
  code: string;
  name: string;
  isPaid: boolean;
}

export interface UpdateBreakTypeInput {
  name?: string;
  isPaid?: boolean;
  isActive?: boolean;
}

export interface ListClockEventsFilter {
  employeeId?: string;
  syncStatus?: SyncStatus;
  limit?: number;
}

export interface InsertClockEventResult {
  event: ClockEvent;
  deduplicated: boolean;
}

export interface CreateCorrectionInput {
  id: string;
  employeeId: string;
  targetEventId: string | null;
  kind: CorrectionKind;
  requestedBy: string;
  reason: string;
  proposedChange: ProposedCorrectionChange;
  preview: CorrectionPreview;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface ListCorrectionsFilter {
  employeeId?: string;
  status?: CorrectionStatus;
  kind?: CorrectionKind;
  fromDate?: string;
  toDate?: string;
}

export interface ApproveCorrectionAtomicInput {
  correctionId: string;
  resolvedByUserId: string;
  resolvedByEmail: string;
  resolvedAtUtc: string;
  resolutionNote: string | null;
  approvalIdempotencyKey: string | null;
  compensatingEvents: InsertClockEventInput[];
  buildOutboxPayload: (
    insertedEvents: ClockEvent[],
    recalculatedSession: WorkSession | null,
  ) => MitaCorrectionOutboxPayload;
  recomputeSessions: (
    allEventsAfterApproval: ClockEvent[],
    existingSessionsById: Map<string, WorkSession>,
  ) => WorkSession[];
}

export interface ApproveCorrectionAtomicResult {
  correction: CorrectionRequest;
  insertedEvents: ClockEvent[];
  outboxItem: MitaOutboxItem | null;
  deduplicated: boolean;
}

export interface CreateAuditLogInput {
  id: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
}

export interface ListPlannedShiftsFilter {
  employeeId?: string;
  fromDate?: string;
  toDate?: string;
}

export interface CreatePlannedShiftInput {
  id: string;
  employeeId: string;
  madridDateKey: string;
  startUtc: string;
  endUtc: string;
  plannedBreakMinutes: number;
  plannedMinutes: number;
  projectRef: string | null;
  facilityRef: string | null;
  assignmentRef: string | null;
  source: PlannedShiftSource;
  templateId?: string | null;
  label: string;
  createdAt: string;
}

export interface UpdatePlannedShiftInput {
  madridDateKey: string;
  startUtc: string;
  endUtc: string;
  plannedBreakMinutes: number;
  plannedMinutes: number;
  projectRef: string | null;
  facilityRef: string | null;
  assignmentRef: string | null;
  label: string;
  updatedAt: string;
}

export interface CreateShiftTemplateInput {
  id: string;
  employeeId: string;
  name: string;
  weekdays: number[];
  startTimeMadrid: string;
  endTimeMadrid: string;
  crossesMidnight: boolean;
  plannedBreakMinutes: number;
  projectRef: string | null;
  facilityRef: string | null;
  validFrom: string;
  validTo: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface UpdateShiftTemplateInput {
  name?: string;
  weekdays?: number[];
  startTimeMadrid?: string;
  endTimeMadrid?: string;
  crossesMidnight?: boolean;
  plannedBreakMinutes?: number;
  projectRef?: string | null;
  facilityRef?: string | null;
  validFrom?: string;
  validTo?: string | null;
  isActive?: boolean;
  updatedAt: string;
}

export interface CreateDayOffInput {
  id: string;
  employeeId: string | null;
  madridDate: string;
  type: DayOffType;
  note: string | null;
  createdAt: string;
}

export interface UpdateClockPolicyInput {
  pastPlannedEndMinutes?: number;
  flagAfterEndMinutes?: number;
  maxOpenHours?: number;
  maxDailyMinutes?: number;
  scheduleToleranceMinutes?: number;
  overrunPolicy?: OverrunPolicy;
  requirePlannedShift?: boolean;
  updatedAt: string;
}

export interface UpsertSessionIncidentInput {
  id: string;
  sessionId: string;
  employeeId: string;
  kind: IncidentKind;
  madridDate: string;
  shiftStartUtc: string;
  plannedEndUtc: string | null;
  detectedAt: string;
}

export interface InitAndSeedOptions {
  seedDemoData?: boolean;
  seedDemoPassword?: string;
  demoMustChangePassword?: boolean;
  repairDemoAccounts?: boolean;
  bootstrapAdmin?: {
    email: string;
    password: string;
    name?: string;
    resetPasswordIfExists?: boolean;
  };
}

/**
 * Interfaz de repositorio desacoplada del motor de base de datos.
 * Implementada sobre PostgreSQL (Neon en producción, PGlite o Postgres en pruebas) sin acoplar el dominio al driver.
 */
export interface ClockRepository {
  initAndSeed(options?: InitAndSeedOptions): Promise<void>;
  ping(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void> | void;

  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserPublicById(userId: string): Promise<UserPublic | null>;
  updateUserPasswordHash(
    userId: string,
    passwordHash: string,
    mustChangePassword: boolean,
  ): Promise<void>;
  listDemoAccounts(): Promise<DemoAccountInfo[]>;

  listEmployees(includeAdmins?: boolean): Promise<Employee[]>;
  findEmployeeByUserId(userId: string): Promise<Employee | null>;
  findEmployeeById(employeeId: string): Promise<Employee | null>;
  createUserAndEmployee(input: CreateUserEmployeeInput): Promise<Employee>;
  updateEmployee(employeeId: string, input: UpdateEmployeeInput): Promise<Employee | null>;
  deleteEmployee(employeeId: string): Promise<DeleteEmployeeResult>;

  listBreakTypes(activeOnly?: boolean): Promise<BreakType[]>;
  createBreakType(input: CreateBreakTypeInput): Promise<BreakType>;
  updateBreakType(id: string, input: UpdateBreakTypeInput): Promise<BreakType | null>;

  listClockEvents(filter?: ListClockEventsFilter): Promise<ClockEvent[]>;
  findClockEventById(id: string): Promise<ClockEvent | null>;
  insertClockEvent(input: InsertClockEventInput): Promise<InsertClockEventResult>;

  listMitaExportEvents(status?: SyncStatus, limit?: number): Promise<MitaExportEvent[]>;
  acknowledgeEvents(eventIds: string[], mitaAckRef: string, confirmedAtUtc: string): Promise<number>;

  // Correcciones, proyecciones de sesión, auditoría y outbox
  createCorrection(input: CreateCorrectionInput): Promise<{ correction: CorrectionRequest; deduplicated: boolean }>;
  findCorrectionById(id: string): Promise<CorrectionRequest | null>;
  findCorrectionByIdempotencyKey(key: string): Promise<CorrectionRequest | null>;
  listCorrections(filter?: ListCorrectionsFilter): Promise<CorrectionRequest[]>;
  cancelCorrection(id: string, resolvedAtUtc: string): Promise<CorrectionRequest | null>;
  rejectCorrection(
    id: string,
    resolvedBy: string,
    resolutionNote: string,
    resolvedAtUtc: string,
  ): Promise<CorrectionRequest | null>;
  approveCorrectionAtomic(input: ApproveCorrectionAtomicInput): Promise<ApproveCorrectionAtomicResult>;

  replaceEmployeeWorkSessions(employeeId: string, sessions: WorkSession[]): Promise<void>;
  listWorkSessions(employeeId?: string): Promise<WorkSession[]>;
  findWorkSessionById(sessionId: string): Promise<WorkSession | null>;
  acknowledgeSessionOverrun(
    sessionId: string,
    reason: string,
    acknowledgedAtUtc: string,
  ): Promise<WorkSession | null>;

  appendAuditLog(input: CreateAuditLogInput): Promise<AuditLogEntry>;
  listAuditLog(limit?: number): Promise<AuditLogEntry[]>;

  listOutboxItems(status?: MitaOutboxItem['status']): Promise<MitaOutboxItem[]>;
  markOutboxSent(id: string, externalAckRef: string, sentAtUtc: string): Promise<void>;
  markOutboxFailed(id: string, errorMessage: string): Promise<void>;

  // Planificación de jornadas, plantillas, días libres, políticas e incidencias
  listPlannedShifts(filter?: ListPlannedShiftsFilter): Promise<PlannedShift[]>;
  findPlannedShiftById(id: string): Promise<PlannedShift | null>;
  createPlannedShift(input: CreatePlannedShiftInput): Promise<PlannedShift>;
  updatePlannedShift(id: string, input: UpdatePlannedShiftInput): Promise<PlannedShift | null>;
  deletePlannedShift(id: string): Promise<boolean>;

  listShiftTemplates(employeeId?: string): Promise<ShiftTemplate[]>;
  findShiftTemplateById(id: string): Promise<ShiftTemplate | null>;
  createShiftTemplate(input: CreateShiftTemplateInput): Promise<ShiftTemplate>;
  updateShiftTemplate(id: string, input: UpdateShiftTemplateInput): Promise<ShiftTemplate | null>;
  deleteShiftTemplate(id: string): Promise<boolean>;

  listDayOffs(filter?: { employeeId?: string; fromDate?: string; toDate?: string }): Promise<DayOff[]>;
  findDayOffById(id: string): Promise<DayOff | null>;
  createDayOff(input: CreateDayOffInput): Promise<DayOff>;
  deleteDayOff(id: string): Promise<boolean>;

  getClockPolicy(): Promise<ClockPolicy>;
  updateClockPolicy(input: UpdateClockPolicyInput): Promise<ClockPolicy>;

  upsertSessionIncident(input: UpsertSessionIncidentInput): Promise<SessionIncident>;
  listSessionIncidents(status?: SessionIncident['status']): Promise<SessionIncident[]>;
  acknowledgeIncident(id: string, userId: string, acknowledgedAtUtc: string): Promise<SessionIncident | null>;
  resolveIncidentsForSession(
    sessionId: string,
    resolvedAtUtc: string,
    correctionId?: string | null,
  ): Promise<void>;
}

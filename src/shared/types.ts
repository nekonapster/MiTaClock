export type UserRole = 'employee' | 'admin';

export type WorkState = 'fuera' | 'en_jornada' | 'en_pausa';

export type ClockEventType =
  | 'shift_start'
  | 'shift_end'
  | 'break_start'
  | 'break_end'
  | 'event_void';

export type EventSource = 'employee' | 'admin';

export type TimeSource = 'server' | 'device_declared';

export type SyncStatus = 'pendiente' | 'enviado' | 'confirmado';

export type HistoryPeriod = 'day' | 'week' | 'month';

export type CorrectionKind = 'void_event' | 'change_time' | 'add_event' | 'void_day';

export type CorrectionStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type WorkSessionStatus = 'open' | 'flagged' | 'closed' | 'incomplete' | 'voided';

export type AnomalyFlag =
  | 'past_planned_end'
  | 'late_end_over_n_hours'
  | 'outside_planned_tolerance'
  | 'open_over_m_hours'
  | 'exceeds_max_shift_hours'
  | 'no_planned_shift';

export type OverrunPolicy = 'flag_only' | 'cap_provisional';

export type PlannedShiftSource = 'local' | 'mita';

export type DayOffType = 'free' | 'holiday' | 'absence';

export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

export type IncidentKind = 'flagged_overrun' | 'incomplete_shift';

export interface ClockPolicy {
  id: string;
  pastPlannedEndMinutes: number;
  flagAfterEndMinutes: number;
  maxOpenHours: number;
  maxDailyMinutes: number;
  scheduleToleranceMinutes: number;
  overrunPolicy: OverrunPolicy;
  requirePlannedShift: boolean;
  updatedAt: string;
}

export interface AnomalyConfig {
  lateEndOverHours: number;
  scheduleToleranceMinutes: number;
  maxOpenHours: number;
  maxShiftMinutes: number;
  pastPlannedEndMinutes?: number;
  flagAfterEndMinutes?: number;
  maxDailyMinutes?: number;
  overrunPolicy?: OverrunPolicy;
  requirePlannedShift?: boolean;
}

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string | null;
  role: UserRole;
  isActive: boolean;
  isDemo: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

export interface UserPublic {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  mustChangePassword: boolean;
  employeeId: string | null;
  employeeName: string | null;
  externalRef: string | null;
}

export interface Employee {
  id: string;
  userId: string;
  email: string;
  role: UserRole;
  externalRef: string | null;
  name: string;
  status: 'active' | 'inactive';
  isUserActive: boolean;
  createdAt: string;
}

export interface BreakType {
  id: string;
  code: string;
  name: string;
  isPaid: boolean;
  isActive: boolean;
}

export interface ClockEvent {
  id: string;
  employeeId: string;
  type: ClockEventType;
  breakTypeId: string | null;
  receivedAt: string;
  deviceDeclaredAt: string;
  deviceOffsetMs: number;
  timeSource: TimeSource;
  source: EventSource;
  correctsEventId: string | null;
  correctionId: string | null;
  assignmentRef: string | null;
  projectRef: string | null;
  facilityRef: string | null;
  syncStatus: SyncStatus;
  mitaAckRef: string | null;
}

export interface InsertClockEventInput {
  id: string;
  employeeId: string;
  type: ClockEventType;
  breakTypeId: string | null;
  receivedAt: string;
  deviceDeclaredAt: string;
  deviceOffsetMs: number;
  timeSource: TimeSource;
  source?: EventSource;
  correctsEventId?: string | null;
  correctionId?: string | null;
  assignmentRef: string | null;
  projectRef: string | null;
  facilityRef: string | null;
}

export interface QueuedClockEvent {
  id: string;
  employeeId: string;
  type: Exclude<ClockEventType, 'event_void'>;
  breakTypeId: string | null;
  deviceDeclaredAt: string;
  deviceOffsetMs: number;
  assignmentRef: string | null;
  projectRef: string | null;
  facilityRef: string | null;
  offline: boolean;
  createdAtMs: number;
}

export interface ShiftBreakSummary {
  id: string;
  startUtc: string;
  endUtc: string | null;
  durationMs: number;
  breakTypeName: string;
  isOpen: boolean;
}

export interface ShiftSummary {
  id: string;
  rootEventId: string;
  employeeId: string;
  startUtc: string;
  endUtc: string | null;
  madridDateKey: string;
  madridWeekKey: string;
  madridMonthKey: string;
  effectiveMs: number;
  breakMs: number;
  breaks: ShiftBreakSummary[];
  isOpen: boolean;
  syncStatus: SyncStatus;
  assignmentRef: string | null;
  projectRef: string | null;
  facilityRef: string | null;
  events: ClockEvent[];
}

export interface WorkStateSnapshot {
  workState: WorkState;
  activeShiftStart: string | null;
  activeBreakStart: string | null;
  activeBreakTypeId: string | null;
  effectiveMs: number;
  breakMs: number;
  breaksCompleted: ShiftBreakSummary[];
  openBreak: ShiftBreakSummary | null;
  activeAssignmentRef: string | null;
  activeProjectRef: string | null;
  activeFacilityRef: string | null;
}

export interface PlannedShift {
  id: string;
  employeeId: string;
  employeeName?: string;
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
  createdAt?: string;
  updatedAt?: string;
}

export interface ShiftTemplate {
  id: string;
  employeeId: string;
  employeeName?: string;
  name: string;
  weekdays: number[]; // 1 = Lunes .. 7 = Domingo
  startTimeMadrid: string; // HH:mm
  endTimeMadrid: string; // HH:mm
  crossesMidnight: boolean;
  plannedBreakMinutes: number;
  projectRef: string | null;
  facilityRef: string | null;
  validFrom: string; // YYYY-MM-DD
  validTo: string | null; // YYYY-MM-DD
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DayOff {
  id: string;
  employeeId: string | null; // null = festivo general
  employeeName?: string | null;
  madridDate: string; // YYYY-MM-DD
  type: DayOffType;
  note: string | null;
  createdAt: string;
}

export interface WorkSession {
  id: string;
  employeeId: string;
  madridDate: string;
  startUtc: string;
  endUtc: string | null;
  status: WorkSessionStatus;
  workedMinutes: number;
  rawWorkedMinutes?: number;
  plannedMinutes: number;
  deltaMinutes: number;
  breakMinutes: number;
  plannedShiftId?: string | null;
  plannedEndUtc?: string | null;
  isProvisionalCap?: boolean;
  overrunAcknowledged?: boolean;
  overrunReason?: string | null;
  overrunAcknowledgedAt?: string | null;
  anomalyFlags: AnomalyFlag[];
  hasPendingCorrection: boolean;
  hasApprovedCorrection: boolean;
  updatedAt: string;
}

export interface SessionIncident {
  id: string;
  sessionId: string;
  employeeId: string;
  employeeName?: string;
  kind: IncidentKind;
  status: IncidentStatus;
  madridDate: string;
  shiftStartUtc: string;
  plannedEndUtc: string | null;
  detectedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedByCorrectionId: string | null;
}

export interface AdminOpenSessionView {
  session: WorkSession;
  employeeName: string;
  employeeEmail: string;
  externalRef: string | null;
  plannedStartUtc: string | null;
  plannedEndUtc: string | null;
  overrunMinutes: number;
  incident: SessionIncident | null;
}

export interface DailySummaryRow {
  employeeId: string;
  employeeName: string;
  externalRef: string | null;
  madridDate: string;
  plannedMinutes: number;
  workedMinutes: number;
  deltaMinutes: number;
  status: 'ok' | 'deviation' | 'flagged' | 'incomplete' | 'absent' | 'day_off';
  isProvisional: boolean;
  dayOffType: DayOffType | null;
}

export interface ProposedCorrectionChange {
  eventType?: Exclude<ClockEventType, 'event_void'>;
  declaredAtUtc?: string;
  madridDateKey?: string;
  voidedEventIds?: string[];
  voidedEventSummaries?: Array<{
    id: string;
    type: ClockEventType;
    deviceDeclaredAt: string;
  }>;
  breakTypeId?: string | null;
  facilityRef?: string | null;
  assignmentRef?: string | null;
  projectRef?: string | null;
}

export interface CorrectionPreview {
  madridDateKey: string;
  beforeWorkedMinutes: number;
  afterWorkedMinutes: number;
  deltaMinutes: number;
}

export interface CorrectionRequest {
  id: string;
  employeeId: string;
  employeeName?: string;
  targetEventId: string | null;
  targetEvent?: ClockEvent | null;
  kind: CorrectionKind;
  requestedBy: string;
  requestedByEmail?: string;
  requestedByName?: string;
  reason: string;
  proposedChange: ProposedCorrectionChange;
  preview: CorrectionPreview;
  status: CorrectionStatus;
  resolvedBy: string | null;
  resolvedByEmail?: string | null;
  resolvedByName?: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  actorUserId: string;
  actorEmail?: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
}

export interface MitaCorrectionOutboxPayload {
  correctionId: string;
  sessionId: string | null;
  employeeId: string;
  employeeExternalRef: string | null;
  employeeName: string;
  correctionKind: CorrectionKind;
  reason: string;
  originalEvent: ClockEvent | null;
  compensatingEvents: ClockEvent[];
  approvedBy: {
    userId: string;
    email: string;
  };
  approvedAtUtc: string;
  recalculatedSession: WorkSession | null;
}

export interface MitaOutboxItem {
  id: string;
  idempotencyKey: string;
  kind: 'correction';
  correctionId: string;
  payload: MitaCorrectionOutboxPayload;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  externalAckRef: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface DemoAccountInfo {
  email: string;
  name: string;
  role: UserRole;
  externalRef: string | null;
  areaLabel: string;
}

export interface AdminEmployeeOverview {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  externalRef: string | null;
  status: 'active' | 'inactive';
  workState: WorkState;
  activeShiftStart: string | null;
  todayEffectiveMs: number;
  pendingSyncCount: number;
}

export interface MitaExportEvent {
  event_id: string;
  employee_id: string;
  employee_external_ref: string | null;
  employee_name: string;
  type: ClockEventType;
  source: EventSource;
  corrects_event_id: string | null;
  break_type_code: string | null;
  received_at_utc: string;
  device_declared_at_utc: string;
  device_offset_ms: number;
  time_source: TimeSource;
  assignment_ref: string | null;
  project_ref: string | null;
  facility_ref: string | null;
  sync_status: SyncStatus;
  mita_ack_ref: string | null;
}

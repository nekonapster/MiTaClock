import type {
  AdminEmployeeOverview,
  AdminOpenSessionView,
  AuditLogEntry,
  BreakType,
  ClockEvent,
  ClockPolicy,
  CorrectionKind,
  CorrectionPreview,
  CorrectionRequest,
  CorrectionStatus,
  DailySummaryRow,
  DayOff,
  DayOffType,
  DemoAccountInfo,
  Employee,
  MitaExportEvent,
  MitaOutboxItem,
  OverrunPolicy,
  PlannedShift,
  ProposedCorrectionChange,
  QueuedClockEvent,
  SessionIncident,
  ShiftTemplate,
  UserPublic,
  UserRole,
  WorkSession,
} from '../shared/types';

export type ServerConnectionStatus = 'idle' | 'connecting' | 'ready';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

let currentServerStatus: ServerConnectionStatus = 'idle';
const serverStatusListeners = new Set<(status: ServerConnectionStatus) => void>();

function setServerStatus(next: ServerConnectionStatus): void {
  if (currentServerStatus === next) return;
  currentServerStatus = next;
  for (const listener of serverStatusListeners) {
    listener(next);
  }
}

export function subscribeServerStatus(
  listener: (status: ServerConnectionStatus) => void,
): () => void {
  serverStatusListeners.add(listener);
  listener(currentServerStatus);
  return () => {
    serverStatusListeners.delete(listener);
  };
}

function isWakeupTransientStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

const SESSION_TOKEN_STORAGE_KEY = 'mita_clock_session_token_v1';

function readStoredSessionToken(): string | null {
  try {
    return window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredSessionToken(token: string | null): void {
  try {
    if (token) {
      window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

interface ApiFetchOptions {
  timeoutMs?: number;
  retryOnWakeup?: boolean;
}

async function apiFetch<T>(
  url: string,
  init: RequestInit = {},
  opts: ApiFetchOptions = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-Requested-With', 'MiTaClock');
  const storedToken = readStoredSessionToken();
  if (storedToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${storedToken}`);
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const method = (init.method || 'GET').toUpperCase();
  const retryOnWakeup = opts.retryOnWakeup ?? method === 'GET';
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const maxAttempts = retryOnWakeup ? 3 : 1;

  let slowTimer: number | null = window.setTimeout(() => {
    setServerStatus('connecting');
  }, 1_200);

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetchWithTimeout(
          url,
          {
            ...init,
            headers,
            credentials: 'include',
          },
          timeoutMs,
        );

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 401 && !url.includes('/auth/login') && !url.includes('/auth/demo-login')) {
            writeStoredSessionToken(null);
          }
          if (retryOnWakeup && isWakeupTransientStatus(res.status) && attempt < maxAttempts) {
            setServerStatus('connecting');
            await delay(attempt === 1 ? 2_000 : 4_000);
            continue;
          }
          throw new ApiError(
            res.status,
            data?.detail || data?.error || `Error ${res.status}`,
            typeof data?.code === 'string' ? data.code : undefined,
          );
        }

        setServerStatus('ready');
        return data as T;
      } catch (err) {
        if (err instanceof ApiError) {
          throw err;
        }
        const canRetry = retryOnWakeup && attempt < maxAttempts && navigator.onLine;
        if (canRetry) {
          setServerStatus('connecting');
          await delay(attempt === 1 ? 2_000 : 4_000);
          continue;
        }
        throw err;
      }
    }
    throw new Error('No se pudo completar la solicitud.');
  } finally {
    if (slowTimer !== null) {
      window.clearTimeout(slowTimer);
      slowTimer = null;
    }
  }
}

export const api = {
  getMe: () => apiFetch<{ user: UserPublic }>('/api/v1/auth/me'),

  getDemoAccounts: () =>
    apiFetch<{ enabled: boolean; accounts: DemoAccountInfo[]; defaultPasswordHint?: string }>(
      '/api/v1/auth/demo-accounts',
    ),

  login: async (email: string, password: string) => {
    const res = await apiFetch<{ user: UserPublic; token?: string }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (res.token) writeStoredSessionToken(res.token);
    return res;
  },

  demoLogin: async (email: string) => {
    const res = await apiFetch<{ user: UserPublic; token?: string }>('/api/v1/auth/demo-login', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    if (res.token) writeStoredSessionToken(res.token);
    return res;
  },

  changePassword: (newPassword: string, currentPassword?: string) =>
    apiFetch<{ user: UserPublic }>('/api/v1/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ newPassword, currentPassword }),
    }),

  logout: async () => {
    try {
      return await apiFetch<{ ok: boolean }>('/api/v1/auth/logout', {
        method: 'POST',
      });
    } finally {
      writeStoredSessionToken(null);
    }
  },

  getBreakTypes: () => apiFetch<{ breakTypes: BreakType[] }>('/api/v1/break-types'),

  getClockEvents: (employeeId?: string) => {
    const query = employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : '';
    return apiFetch<{ events: ClockEvent[] }>(`/api/v1/clock-events${query}`);
  },

  submitBatchEvents: (events: QueuedClockEvent[]) =>
    apiFetch<{ results: Array<{ event: ClockEvent; deduplicated: boolean }> }>(
      '/api/v1/clock-events/batch',
      {
        method: 'POST',
        body: JSON.stringify({
          events: events.map((ev) => ({
            id: ev.id,
            type: ev.type,
            breakTypeId: ev.breakTypeId,
            deviceDeclaredAt: ev.deviceDeclaredAt,
            deviceOffsetMs: ev.deviceOffsetMs,
            assignmentRef: ev.assignmentRef,
            projectRef: ev.projectRef,
            facilityRef: ev.facilityRef,
            offline: ev.offline,
          })),
        }),
      },
      { timeoutMs: 12_000, retryOnWakeup: false },
    ),

  // v1 Turnos, Sesiones, Anomalías y Correcciones
  getTodayShift: () =>
    apiFetch<{
      todayKey: string;
      plannedShift: PlannedShift | null;
      activeSession: WorkSession | null;
      policy: ClockPolicy;
      showOverrunPrompt: boolean;
      overrunMinutes: number;
    }>('/api/v1/clock/shifts/today'),

  getClockShifts: (filters?: { from?: string; to?: string; employeeId?: string }) => {
    const params = new URLSearchParams();
    if (filters?.from) params.set('from', filters.from);
    if (filters?.to) params.set('to', filters.to);
    if (filters?.employeeId) params.set('employeeId', filters.employeeId);
    const q = params.toString();
    return apiFetch<{
      shifts: PlannedShift[];
      from: string;
      to: string;
      businessTimezone: string;
    }>(`/api/v1/clock/shifts${q ? `?${q}` : ''}`);
  },

  acknowledgeSessionOverrun: (sessionId: string, reason: string) =>
    apiFetch<{ session: WorkSession }>(
      `/api/v1/clock/sessions/${encodeURIComponent(sessionId)}/acknowledge-overrun`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
    ),

  getNextShifts: (employeeId?: string) => {
    const query = employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : '';
    return apiFetch<{ shifts: PlannedShift[]; businessTimezone: string }>(
      `/api/v1/clock/shifts/next${query}`,
    );
  },

  getWorkSessions: (employeeId?: string) => {
    const query = employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : '';
    return apiFetch<{ sessions: WorkSession[]; lookbackDays: number }>(
      `/api/v1/clock/sessions${query}`,
    );
  },

  getCorrections: (filters?: {
    employeeId?: string;
    status?: CorrectionStatus;
    kind?: CorrectionKind;
    from?: string;
    to?: string;
  }) => {
    const params = new URLSearchParams();
    if (filters?.employeeId) params.set('employeeId', filters.employeeId);
    if (filters?.status) params.set('status', filters.status);
    if (filters?.kind) params.set('kind', filters.kind);
    if (filters?.from) params.set('from', filters.from);
    if (filters?.to) params.set('to', filters.to);
    const q = params.toString();
    return apiFetch<{ corrections: CorrectionRequest[] }>(
      `/api/v1/clock/corrections${q ? `?${q}` : ''}`,
    );
  },

  createCorrection: (
    payload: {
      employeeId?: string;
      targetEventId: string | null;
      kind: CorrectionKind;
      reason: string;
      proposedChange?: ProposedCorrectionChange;
    },
    idempotencyKey: string,
  ) =>
    apiFetch<{
      correction: CorrectionRequest;
      preview: CorrectionPreview;
      deduplicated: boolean;
    }>('/api/v1/clock/corrections', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    }),

  cancelCorrection: (id: string) =>
    apiFetch<{ correction: CorrectionRequest }>(
      `/api/v1/clock/corrections/${encodeURIComponent(id)}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    ),

  approveCorrection: (id: string, resolutionNote?: string, idempotencyKey?: string) =>
    apiFetch<{
      correction: CorrectionRequest;
      compensatingEvents: ClockEvent[];
      deduplicated: boolean;
    }>(`/api/v1/clock/corrections/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      body: JSON.stringify({ resolutionNote }),
    }),

  rejectCorrection: (id: string, resolutionNote: string) =>
    apiFetch<{ correction: CorrectionRequest }>(
      `/api/v1/clock/corrections/${encodeURIComponent(id)}/reject`,
      {
        method: 'POST',
        body: JSON.stringify({ resolutionNote }),
      },
    ),

  // Planificación de jornadas, plantillas, días libres, políticas, vigilancia y resumen diario
  getAdminShifts: (filters?: { from?: string; to?: string; employeeId?: string }) => {
    const params = new URLSearchParams();
    if (filters?.from) params.set('from', filters.from);
    if (filters?.to) params.set('to', filters.to);
    if (filters?.employeeId) params.set('employeeId', filters.employeeId);
    const q = params.toString();
    return apiFetch<{ shifts: PlannedShift[] }>(`/api/v1/admin/shifts${q ? `?${q}` : ''}`);
  },

  createAdminShift: (payload: {
    employeeId: string;
    madridDateKey: string;
    startTimeMadrid: string;
    endTimeMadrid: string;
    crossesMidnight?: boolean;
    plannedBreakMinutes?: number;
    projectRef?: string | null;
    facilityRef?: string | null;
    assignmentRef?: string | null;
  }) =>
    apiFetch<{ shift: PlannedShift }>('/api/v1/admin/shifts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateAdminShift: (
    id: string,
    payload: {
      madridDateKey?: string;
      startTimeMadrid?: string;
      endTimeMadrid?: string;
      crossesMidnight?: boolean;
      plannedBreakMinutes?: number;
      projectRef?: string | null;
      facilityRef?: string | null;
      assignmentRef?: string | null;
    },
  ) =>
    apiFetch<{ shift: PlannedShift }>(`/api/v1/admin/shifts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  deleteAdminShift: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/v1/admin/shifts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  generateShiftsFromTemplate: (payload: { templateId: string; from: string; to: string }) =>
    apiFetch<{
      createdCount: number;
      skippedCount: number;
      skippedDates: string[];
      shifts: PlannedShift[];
    }>('/api/v1/admin/shifts/generate', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  copyWeekShifts: (payload: { sourceMonday: string; targetMonday: string; employeeId?: string }) =>
    apiFetch<{ createdCount: number; skippedCount: number; shifts: PlannedShift[] }>(
      '/api/v1/admin/shifts/copy-week',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),

  getShiftTemplates: (employeeId?: string) => {
    const q = employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : '';
    return apiFetch<{ templates: ShiftTemplate[] }>(`/api/v1/admin/shift-templates${q}`);
  },

  createShiftTemplate: (payload: {
    employeeId: string;
    name: string;
    weekdays: number[];
    startTimeMadrid: string;
    endTimeMadrid: string;
    crossesMidnight?: boolean;
    plannedBreakMinutes?: number;
    projectRef?: string | null;
    facilityRef?: string | null;
    validFrom: string;
    validTo?: string | null;
  }) =>
    apiFetch<{ template: ShiftTemplate }>('/api/v1/admin/shift-templates', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteShiftTemplate: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/v1/admin/shift-templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  getDayOffs: (filters?: { from?: string; to?: string; employeeId?: string }) => {
    const params = new URLSearchParams();
    if (filters?.from) params.set('from', filters.from);
    if (filters?.to) params.set('to', filters.to);
    if (filters?.employeeId) params.set('employeeId', filters.employeeId);
    const q = params.toString();
    return apiFetch<{ dayOffs: DayOff[] }>(`/api/v1/admin/day-offs${q ? `?${q}` : ''}`);
  },

  createDayOff: (payload: {
    employeeId: string | null;
    madridDate: string;
    type: DayOffType;
    note?: string | null;
  }) =>
    apiFetch<{ dayOff: DayOff }>('/api/v1/admin/day-offs', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteDayOff: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/v1/admin/day-offs/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  getClockPolicy: () => apiFetch<{ policy: ClockPolicy }>('/api/v1/admin/policies'),

  updateClockPolicy: (payload: {
    pastPlannedEndMinutes?: number;
    flagAfterEndMinutes?: number;
    maxOpenHours?: number;
    maxDailyMinutes?: number;
    scheduleToleranceMinutes?: number;
    overrunPolicy?: OverrunPolicy;
    requirePlannedShift?: boolean;
  }) =>
    apiFetch<{ policy: ClockPolicy }>('/api/v1/admin/policies', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  getAdminOpenSessions: () =>
    apiFetch<{ openSessions: AdminOpenSessionView[]; openIncidentCount: number }>(
      '/api/v1/admin/open-sessions',
    ),

  runWatchdog: () =>
    apiFetch<{
      summary: {
        checkedEmployees: number;
        flaggedCount: number;
        incompleteCount: number;
        openedIncidents: SessionIncident[];
      };
    }>('/api/v1/admin/watchdog/run', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  acknowledgeIncident: (id: string) =>
    apiFetch<{ incident: SessionIncident }>(
      `/api/v1/admin/incidents/${encodeURIComponent(id)}/acknowledge`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    ),

  getDailySummary: (filters?: { from?: string; to?: string; employeeId?: string }) => {
    const params = new URLSearchParams();
    if (filters?.from) params.set('from', filters.from);
    if (filters?.to) params.set('to', filters.to);
    if (filters?.employeeId) params.set('employeeId', filters.employeeId);
    const q = params.toString();
    return apiFetch<{ rows: DailySummaryRow[]; from: string; to: string }>(
      `/api/v1/admin/daily-summary${q ? `?${q}` : ''}`,
    );
  },

  getAuditLog: (limit: number = 100) =>
    apiFetch<{ entries: AuditLogEntry[] }>(`/api/v1/admin/audit-log?limit=${limit}`),

  getOutboxItems: () => apiFetch<{ items: MitaOutboxItem[] }>('/api/v1/admin/outbox'),

  processOutbox: () =>
    apiFetch<{ sentCount: number; failedCount: number; items: MitaOutboxItem[] }>(
      '/api/v1/admin/outbox/process',
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    ),

  // Admin existentes
  getAdminOverview: () =>
    apiFetch<{ employees: AdminEmployeeOverview[]; totalEvents: number }>('/api/v1/admin/overview'),

  getAdminEmployees: (includeAdmins: boolean = false) =>
    apiFetch<{ employees: Employee[] }>(
      `/api/v1/admin/employees${includeAdmins ? '?includeAdmins=true' : ''}`,
    ),

  createEmployee: (payload: {
    name: string;
    email: string;
    password: string;
    role: UserRole;
    externalRef: string | null;
  }) =>
    apiFetch<{ employee: Employee }>('/api/v1/admin/employees', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateEmployee: (
    id: string,
    payload: {
      name?: string;
      email?: string;
      role?: UserRole;
      password?: string;
      externalRef?: string | null;
      status?: 'active' | 'inactive';
      isUserActive?: boolean;
    },
  ) =>
    apiFetch<{ employee: Employee }>(`/api/v1/admin/employees/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteEmployee: (id: string) =>
    apiFetch<{ ok: boolean; deletedId: string }>(
      `/api/v1/admin/employees/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
      },
    ),

  createBreakType: (payload: { code: string; name: string; isPaid: boolean }) =>
    apiFetch<{ breakType: BreakType }>('/api/v1/admin/break-types', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateBreakType: (id: string, payload: { name?: string; isPaid?: boolean; isActive?: boolean }) =>
    apiFetch<{ breakType: BreakType }>(`/api/v1/admin/break-types/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  // MiTa v2.0 REST sync
  getMitaEvents: (status?: 'enviado' | 'confirmado') => {
    const query = status ? `?status=${status}` : '';
    return apiFetch<{
      schema_version: string;
      count: number;
      events: MitaExportEvent[];
    }>(`/api/v1/mita/events${query}`);
  },

  confirmMitaEvents: (eventIds: string[], mitaAckRef?: string) =>
    apiFetch<{ ok: boolean; confirmedCount: number; mita_ack_ref: string }>(
      '/api/v1/mita/confirm',
      {
        method: 'POST',
        body: JSON.stringify({ event_ids: eventIds, mita_ack_ref: mitaAckRef }),
      },
    ),
};

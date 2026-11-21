import type {
  BreakType,
  ClockEvent,
  ClockEventType,
  ShiftBreakSummary,
  ShiftSummary,
  SyncStatus,
  WorkState,
  WorkStateSnapshot,
} from './types.ts';

export const BUSINESS_TIMEZONE = 'Europe/Madrid';

const madridDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const madridTimeFormatter = new Intl.DateTimeFormat('es-ES', {
  timeZone: BUSINESS_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const madridFullDateFormatter = new Intl.DateTimeFormat('es-ES', {
  timeZone: BUSINESS_TIMEZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const madridPartsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function addDaysToDateKey(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function getMadridIsoWeekday(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  return day === 0 ? 7 : day; // 1 = Lunes .. 7 = Domingo
}

export function getMondayOfWeek(dateKey: string): string {
  const isoDay = getMadridIsoWeekday(dateKey);
  return addDaysToDateKey(dateKey, -(isoDay - 1));
}

export function enumerateDateKeys(fromDateKey: string, toDateKey: string): string[] {
  const result: string[] = [];
  if (fromDateKey > toDateKey) return result;
  let cursor = fromDateKey;
  let guard = 0;
  while (cursor <= toDateKey && guard < 400) {
    result.push(cursor);
    cursor = addDaysToDateKey(cursor, 1);
    guard += 1;
  }
  return result;
}

export function getEffectiveClockEvents(events: ClockEvent[]): {
  effectiveEvents: ClockEvent[];
  voidedEventIds: Set<string>;
} {
  const voidedEventIds = new Set<string>();
  for (const ev of events) {
    if (ev.type === 'event_void' && ev.correctsEventId) {
      voidedEventIds.add(ev.correctsEventId);
    }
  }
  const effectiveEvents = events.filter(
    (ev) => ev.type !== 'event_void' && !voidedEventIds.has(ev.id),
  );
  return { effectiveEvents, voidedEventIds };
}

export function resolveRootEventId(event: ClockEvent, allEventsById: Map<string, ClockEvent>): string {
  let current: ClockEvent | undefined = event;
  const visited = new Set<string>();
  while (current?.correctsEventId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = allEventsById.get(current.correctsEventId);
    if (!parent) break;
    current = parent;
  }
  return current ? current.id : event.id;
}

export function sortEventsChronologically(events: ClockEvent[]): ClockEvent[] {
  return [...events].sort((a, b) => {
    const da = Date.parse(a.deviceDeclaredAt);
    const db = Date.parse(b.deviceDeclaredAt);
    if (da !== db) return da - db;
    const ra = Date.parse(a.receivedAt);
    const rb = Date.parse(b.receivedAt);
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
}

export function getMadridDateKey(utcIso: string): string {
  return madridDateFormatter.format(new Date(utcIso));
}

export function getMadridMonthKey(utcIso: string): string {
  return getMadridDateKey(utcIso).slice(0, 7);
}

export function getMadridWeekKey(utcIso: string): string {
  const dateKey = getMadridDateKey(utcIso);
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Convierte una fecha/hora local en Europe/Madrid (YYYY-MM-DD y HH:mm) a UTC ISO-8601.
 */
export function madridLocalToUtcIso(dateKey: string, timeHm: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = timeHm.split(':').map(Number);
  let candidateMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let i = 0; i < 2; i++) {
    const parts = madridPartsFormatter.formatToParts(new Date(candidateMs));
    const map: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== 'literal') map[p.type] = Number(p.value);
    }
    const observedMs = Date.UTC(
      map.year,
      map.month - 1,
      map.day,
      map.hour === 24 ? 0 : map.hour,
      map.minute,
      0,
      0,
    );
    const targetMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    candidateMs += targetMs - observedMs;
  }
  return new Date(candidateMs).toISOString();
}

export function formatMadridTime(utcIso: string): string {
  return madridTimeFormatter.format(new Date(utcIso));
}

export function formatMadridDateTimeInput(utcIso: string): { date: string; time: string } {
  return {
    date: getMadridDateKey(utcIso),
    time: formatMadridTime(utcIso),
  };
}

export function formatMadridDateLabel(utcIso: string): string {
  return madridFullDateFormatter.format(new Date(utcIso));
}

export function formatDurationHms(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((v) => String(v).padStart(2, '0')).join(':');
}

export function formatDurationShort(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return `${hours} h ${String(minutes).padStart(2, '0')} min`;
}

export function formatMinutesShort(minutesTotal: number): string {
  const sign = minutesTotal < 0 ? '-' : '';
  const safe = Math.abs(Math.round(minutesTotal));
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  if (hours === 0) return `${sign}${minutes} min`;
  return `${sign}${hours} h ${String(minutes).padStart(2, '0')} min`;
}

export function validateTransition(
  currentState: WorkState,
  nextType: ClockEventType,
): { ok: true } | { ok: false; reason: string } {
  if (nextType === 'event_void') {
    return { ok: true };
  }
  if (currentState === 'fuera') {
    if (nextType === 'shift_start') return { ok: true };
    return { ok: false, reason: 'Debes iniciar jornada antes de registrar pausas o salidas.' };
  }
  if (currentState === 'en_jornada') {
    if (nextType === 'break_start' || nextType === 'shift_end') return { ok: true };
    return { ok: false, reason: 'Ya tienes una jornada iniciada.' };
  }
  if (currentState === 'en_pausa') {
    if (nextType === 'break_end' || nextType === 'shift_end') return { ok: true };
    return { ok: false, reason: 'Estás en pausa; reanuda o finaliza la jornada.' };
  }
  return { ok: false, reason: 'Estado de jornada no válido.' };
}

function aggregateSyncStatus(events: ClockEvent[]): SyncStatus {
  if (events.some((e) => e.syncStatus === 'pendiente')) return 'pendiente';
  if (events.some((e) => e.syncStatus === 'enviado')) return 'enviado';
  return 'confirmado';
}

export function buildShiftsFromEvents(
  events: ClockEvent[],
  breakTypes: BreakType[],
  nowMs: number = Date.now(),
): ShiftSummary[] {
  const allById = new Map(events.map((e) => [e.id, e]));
  const { effectiveEvents } = getEffectiveClockEvents(events);
  const sorted = sortEventsChronologically(effectiveEvents);
  const breakTypeMap = new Map(breakTypes.map((bt) => [bt.id, bt.name]));
  const shifts: ShiftSummary[] = [];

  let currentShift: {
    id: string;
    rootEventId: string;
    employeeId: string;
    startUtc: string;
    endUtc: string | null;
    assignmentRef: string | null;
    projectRef: string | null;
    facilityRef: string | null;
    events: ClockEvent[];
    breaks: ShiftBreakSummary[];
    openBreakStart: ClockEvent | null;
  } | null = null;

  for (const ev of sorted) {
    if (ev.type === 'shift_start') {
      if (currentShift) {
        // Turno previo quedó sin shift_end antes de un nuevo shift_start
        if (currentShift.openBreakStart) {
          const bStartMs = Date.parse(currentShift.openBreakStart.deviceDeclaredAt);
          const bEndMs = Date.parse(ev.deviceDeclaredAt);
          const label =
            (currentShift.openBreakStart.breakTypeId &&
              breakTypeMap.get(currentShift.openBreakStart.breakTypeId)) ||
            'Pausa';
          currentShift.breaks.push({
            id: currentShift.openBreakStart.id,
            startUtc: currentShift.openBreakStart.deviceDeclaredAt,
            endUtc: null,
            durationMs: Math.max(0, bEndMs - bStartMs),
            breakTypeName: label,
            isOpen: true,
          });
          currentShift.openBreakStart = null;
        }
        shifts.push(finalizeShiftSummary(currentShift, Date.parse(ev.deviceDeclaredAt)));
      }
      const rootId = resolveRootEventId(ev, allById);
      currentShift = {
        id: rootId,
        rootEventId: rootId,
        employeeId: ev.employeeId,
        startUtc: ev.deviceDeclaredAt,
        endUtc: null,
        assignmentRef: ev.assignmentRef,
        projectRef: ev.projectRef,
        facilityRef: ev.facilityRef,
        events: [ev],
        breaks: [],
        openBreakStart: null,
      };
      continue;
    }

    if (!currentShift) continue;
    currentShift.events.push(ev);

    if (ev.type === 'break_start') {
      if (!currentShift.openBreakStart) {
        currentShift.openBreakStart = ev;
      }
    } else if (ev.type === 'break_end') {
      if (currentShift.openBreakStart) {
        const startMs = Date.parse(currentShift.openBreakStart.deviceDeclaredAt);
        const endMs = Date.parse(ev.deviceDeclaredAt);
        const label =
          (currentShift.openBreakStart.breakTypeId &&
            breakTypeMap.get(currentShift.openBreakStart.breakTypeId)) ||
          'Pausa';
        currentShift.breaks.push({
          id: currentShift.openBreakStart.id,
          startUtc: currentShift.openBreakStart.deviceDeclaredAt,
          endUtc: ev.deviceDeclaredAt,
          durationMs: Math.max(0, endMs - startMs),
          breakTypeName: label,
          isOpen: false,
        });
        currentShift.openBreakStart = null;
      }
    } else if (ev.type === 'shift_end') {
      if (currentShift.openBreakStart) {
        const startMs = Date.parse(currentShift.openBreakStart.deviceDeclaredAt);
        const endMs = Date.parse(ev.deviceDeclaredAt);
        const label =
          (currentShift.openBreakStart.breakTypeId &&
            breakTypeMap.get(currentShift.openBreakStart.breakTypeId)) ||
          'Pausa';
        currentShift.breaks.push({
          id: currentShift.openBreakStart.id,
          startUtc: currentShift.openBreakStart.deviceDeclaredAt,
          endUtc: ev.deviceDeclaredAt,
          durationMs: Math.max(0, endMs - startMs),
          breakTypeName: label,
          isOpen: false,
        });
        currentShift.openBreakStart = null;
      }
      currentShift.endUtc = ev.deviceDeclaredAt;
      shifts.push(finalizeShiftSummary(currentShift, nowMs));
      currentShift = null;
    }
  }

  if (currentShift) {
    if (currentShift.openBreakStart) {
      const startMs = Date.parse(currentShift.openBreakStart.deviceDeclaredAt);
      const label =
        (currentShift.openBreakStart.breakTypeId &&
          breakTypeMap.get(currentShift.openBreakStart.breakTypeId)) ||
        'Pausa';
      currentShift.breaks.push({
        id: currentShift.openBreakStart.id,
        startUtc: currentShift.openBreakStart.deviceDeclaredAt,
        endUtc: null,
        durationMs: Math.max(0, nowMs - startMs),
        breakTypeName: label,
        isOpen: true,
      });
    }
    shifts.push(finalizeShiftSummary(currentShift, nowMs));
  }

  return shifts;
}

function finalizeShiftSummary(
  draft: {
    id: string;
    rootEventId: string;
    employeeId: string;
    startUtc: string;
    endUtc: string | null;
    assignmentRef: string | null;
    projectRef: string | null;
    facilityRef: string | null;
    events: ClockEvent[];
    breaks: ShiftBreakSummary[];
  },
  nowMs: number,
): ShiftSummary {
  const startMs = Date.parse(draft.startUtc);
  const endMs = draft.endUtc ? Date.parse(draft.endUtc) : nowMs;
  const totalElapsedMs = Math.max(0, endMs - startMs);
  const breakMs = draft.breaks.reduce((acc, item) => acc + item.durationMs, 0);
  const effectiveMs = Math.max(0, totalElapsedMs - breakMs);

  return {
    id: draft.id,
    rootEventId: draft.rootEventId,
    employeeId: draft.employeeId,
    startUtc: draft.startUtc,
    endUtc: draft.endUtc,
    madridDateKey: getMadridDateKey(draft.startUtc),
    madridWeekKey: getMadridWeekKey(draft.startUtc),
    madridMonthKey: getMadridMonthKey(draft.startUtc),
    effectiveMs,
    breakMs,
    breaks: draft.breaks,
    isOpen: draft.endUtc === null,
    syncStatus: aggregateSyncStatus(draft.events),
    assignmentRef: draft.assignmentRef,
    projectRef: draft.projectRef,
    facilityRef: draft.facilityRef,
    events: draft.events,
  };
}

export function computeWorkState(
  events: ClockEvent[],
  nowMs: number = Date.now(),
  breakTypes: BreakType[] = [],
  options?: {
    maxOpenHours?: number;
    incompleteSessionIds?: Set<string>;
  },
): WorkStateSnapshot {
  const shifts = buildShiftsFromEvents(events, breakTypes, nowMs);
  const lastShift = shifts.length > 0 ? shifts[shifts.length - 1] : null;
  const maxOpenHours = options?.maxOpenHours ?? 12;

  const isExpiredIncomplete =
    Boolean(lastShift && lastShift.isOpen) &&
    ((nowMs - Date.parse(lastShift!.startUtc)) >= maxOpenHours * 3_600_000 ||
      Boolean(options?.incompleteSessionIds?.has(lastShift!.id)));

  if (!lastShift || !lastShift.isOpen || isExpiredIncomplete) {
    return {
      workState: 'fuera',
      activeShiftStart: null,
      activeBreakStart: null,
      activeBreakTypeId: null,
      effectiveMs: 0,
      breakMs: 0,
      breaksCompleted: [],
      openBreak: null,
      activeAssignmentRef: null,
      activeProjectRef: null,
      activeFacilityRef: null,
    };
  }

  const openBreak = lastShift.breaks.find((b) => b.isOpen) ?? null;
  const openBreakEvent = openBreak
    ? lastShift.events.find((e) => e.id === openBreak.id) ?? null
    : null;

  return {
    workState: openBreak ? 'en_pausa' : 'en_jornada',
    activeShiftStart: lastShift.startUtc,
    activeBreakStart: openBreak ? openBreak.startUtc : null,
    activeBreakTypeId: openBreakEvent?.breakTypeId ?? null,
    effectiveMs: lastShift.effectiveMs,
    breakMs: lastShift.breakMs,
    breaksCompleted: lastShift.breaks.filter((b) => !b.isOpen),
    openBreak,
    activeAssignmentRef: lastShift.assignmentRef,
    activeProjectRef: lastShift.projectRef,
    activeFacilityRef: lastShift.facilityRef,
  };
}

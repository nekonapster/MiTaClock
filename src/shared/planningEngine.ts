import {
  addDaysToDateKey,
  enumerateDateKeys,
  getMadridDateKey,
  getMadridIsoWeekday,
  madridLocalToUtcIso,
} from './timeEngine.ts';
import type {
  DailySummaryRow,
  DayOff,
  Employee,
  PlannedShift,
  ShiftSummary,
  ShiftTemplate,
  WorkSession,
} from './types.ts';

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidDateKey(value: string): boolean {
  if (!DATE_KEY_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function isValidTimeHm(value: string): boolean {
  return TIME_HM_RE.test(value);
}

export function computePlannedShiftBounds(params: {
  madridDateKey: string;
  startTimeMadrid: string;
  endTimeMadrid: string;
  crossesMidnight?: boolean;
  plannedBreakMinutes?: number;
}):
  | {
      ok: true;
      madridDateKey: string;
      startUtc: string;
      endUtc: string;
      plannedBreakMinutes: number;
      plannedMinutes: number;
      label: string;
    }
  | { ok: false; status: 422; reason: string } {
  const { madridDateKey, startTimeMadrid, endTimeMadrid } = params;
  const crossesMidnight = Boolean(params.crossesMidnight);
  const plannedBreakMinutes = Math.round(Number(params.plannedBreakMinutes ?? 0));

  if (!isValidDateKey(madridDateKey)) {
    return { ok: false, status: 422, reason: 'La fecha de negocio debe tener formato YYYY-MM-DD válido.' };
  }
  if (!isValidTimeHm(startTimeMadrid) || !isValidTimeHm(endTimeMadrid)) {
    return { ok: false, status: 422, reason: 'Las horas de inicio y fin deben tener formato HH:mm.' };
  }
  if (!Number.isFinite(plannedBreakMinutes) || plannedBreakMinutes < 0) {
    return { ok: false, status: 422, reason: 'La pausa planificada no puede ser negativa.' };
  }

  const startUtc = madridLocalToUtcIso(madridDateKey, startTimeMadrid);
  const endDateKey = crossesMidnight ? addDaysToDateKey(madridDateKey, 1) : madridDateKey;
  const endUtc = madridLocalToUtcIso(endDateKey, endTimeMadrid);

  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);

  if (endMs <= startMs) {
    return {
      ok: false,
      status: 422,
      reason: 'La hora de fin debe ser posterior a la hora de inicio (activa turno nocturno si cruza medianoche).',
    };
  }

  const grossMinutes = Math.round((endMs - startMs) / 60_000);
  if (plannedBreakMinutes > grossMinutes || grossMinutes - plannedBreakMinutes <= 0) {
    return {
      ok: false,
      status: 422,
      reason: 'La pausa planificada no puede igualar o superar la duración total de la jornada.',
    };
  }

  const plannedMinutes = grossMinutes - plannedBreakMinutes;
  return {
    ok: true,
    madridDateKey,
    startUtc,
    endUtc,
    plannedBreakMinutes,
    plannedMinutes,
    label: `Turno ${startTimeMadrid}–${endTimeMadrid}${crossesMidnight ? ' (+1d)' : ''}`,
  };
}

export function validateNoShiftOverlap(
  candidate: { id?: string; employeeId: string; startUtc: string; endUtc: string },
  existingShifts: PlannedShift[],
): { ok: true } | { ok: false; status: 409; reason: string; conflict: PlannedShift } {
  const candStart = Date.parse(candidate.startUtc);
  const candEnd = Date.parse(candidate.endUtc);

  for (const existing of existingShifts) {
    if (existing.employeeId !== candidate.employeeId) continue;
    if (candidate.id && existing.id === candidate.id) continue;
    const exStart = Date.parse(existing.startUtc);
    const exEnd = Date.parse(existing.endUtc);
    if (candStart < exEnd && candEnd > exStart) {
      return {
        ok: false,
        status: 409,
        reason: `La jornada se solapa con otra planificada el ${existing.madridDateKey} (${existing.label}).`,
        conflict: existing,
      };
    }
  }

  return { ok: true };
}

export function mergeMitaAndLocalShifts(
  localShifts: PlannedShift[],
  externalShifts: PlannedShift[],
): PlannedShift[] {
  const map = new Map<string, PlannedShift>();
  const keyOf = (s: PlannedShift) => `${s.employeeId}::${s.madridDateKey}`;

  for (const s of localShifts) {
    map.set(keyOf(s), s);
  }
  for (const s of externalShifts) {
    const existing = map.get(keyOf(s));
    if (!existing || s.source === 'mita' || existing.source === 'local') {
      map.set(keyOf(s), s);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

export function expandTemplateInRange(params: {
  template: ShiftTemplate;
  fromDateKey: string;
  toDateKey: string;
  existingShifts: PlannedShift[];
  dayOffs: DayOff[];
}): {
  toCreate: Array<{
    madridDateKey: string;
    startUtc: string;
    endUtc: string;
    plannedBreakMinutes: number;
    plannedMinutes: number;
    projectRef: string | null;
    facilityRef: string | null;
    templateId: string;
    label: string;
  }>;
  skippedDates: string[];
} {
  const { template, fromDateKey, toDateKey, existingShifts, dayOffs } = params;
  const weekdaySet = new Set(template.weekdays);
  const existingDateSet = new Set(
    existingShifts
      .filter((s) => s.employeeId === template.employeeId)
      .map((s) => s.madridDateKey),
  );
  const offDateSet = new Set(
    dayOffs
      .filter((d) => d.employeeId === null || d.employeeId === template.employeeId)
      .map((d) => d.madridDate),
  );

  const dates = enumerateDateKeys(fromDateKey, toDateKey);
  const toCreate: Array<{
    madridDateKey: string;
    startUtc: string;
    endUtc: string;
    plannedBreakMinutes: number;
    plannedMinutes: number;
    projectRef: string | null;
    facilityRef: string | null;
    templateId: string;
    label: string;
  }> = [];
  const skippedDates: string[] = [];

  for (const dateKey of dates) {
    if (dateKey < template.validFrom) continue;
    if (template.validTo && dateKey > template.validTo) continue;
    const weekday = getMadridIsoWeekday(dateKey);
    if (!weekdaySet.has(weekday)) continue;

    if (offDateSet.has(dateKey) || existingDateSet.has(dateKey)) {
      skippedDates.push(dateKey);
      continue;
    }

    const bounds = computePlannedShiftBounds({
      madridDateKey: dateKey,
      startTimeMadrid: template.startTimeMadrid,
      endTimeMadrid: template.endTimeMadrid,
      crossesMidnight: template.crossesMidnight,
      plannedBreakMinutes: template.plannedBreakMinutes,
    });

    if (!bounds.ok) {
      skippedDates.push(dateKey);
      continue;
    }

    const overlap = validateNoShiftOverlap(
      {
        employeeId: template.employeeId,
        startUtc: bounds.startUtc,
        endUtc: bounds.endUtc,
      },
      [
        ...existingShifts,
        ...toCreate.map((c) => ({
          id: `draft-${c.madridDateKey}`,
          employeeId: template.employeeId,
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
    );

    if (!overlap.ok) {
      skippedDates.push(dateKey);
      continue;
    }

    toCreate.push({
      madridDateKey: bounds.madridDateKey,
      startUtc: bounds.startUtc,
      endUtc: bounds.endUtc,
      plannedBreakMinutes: bounds.plannedBreakMinutes,
      plannedMinutes: bounds.plannedMinutes,
      projectRef: template.projectRef,
      facilityRef: template.facilityRef,
      templateId: template.id,
      label: bounds.label,
    });
  }

  return { toCreate, skippedDates };
}

export function findPlannedShiftForShift(
  shift: Pick<ShiftSummary, 'employeeId' | 'startUtc' | 'madridDateKey'>,
  plannedShifts: PlannedShift[],
): PlannedShift | null {
  const empShifts = plannedShifts.filter((p) => p.employeeId === shift.employeeId);
  const direct = empShifts.find((p) => p.madridDateKey === shift.madridDateKey);
  if (direct) return direct;

  // Turnos nocturnos o fichajes cercanos al cambio de medianoche
  const startMs = Date.parse(shift.startUtc);
  let best: PlannedShift | null = null;
  let bestDiff = Infinity;
  for (const p of empShifts) {
    const pStart = Date.parse(p.startUtc);
    const pEnd = Date.parse(p.endUtc);
    if (startMs >= pStart - 4 * 3_600_000 && startMs <= pEnd) {
      const diff = Math.abs(startMs - pStart);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = p;
      }
    }
  }
  return best;
}

export function findPlannedShiftForNow(
  employeeId: string,
  nowMs: number,
  plannedShifts: PlannedShift[],
): PlannedShift | null {
  const todayKey = getMadridDateKey(new Date(nowMs).toISOString());
  const empShifts = plannedShifts.filter((p) => p.employeeId === employeeId);

  // Primero si hay un turno activo justo ahora (incluye turnos nocturnos empezados ayer)
  const coveringNow = empShifts.find((p) => {
    const s = Date.parse(p.startUtc);
    const e = Date.parse(p.endUtc);
    return nowMs >= s - 60 * 60_000 && nowMs <= e + 6 * 3_600_000;
  });
  const todayShift = empShifts.find((p) => p.madridDateKey === todayKey) ?? null;
  return todayShift ?? coveringNow ?? null;
}

export function buildDailySummary(params: {
  employees: Employee[];
  fromDateKey: string;
  toDateKey: string;
  plannedShifts: PlannedShift[];
  sessions: WorkSession[];
  dayOffs: DayOff[];
  toleranceMinutes?: number;
}): DailySummaryRow[] {
  const {
    employees,
    fromDateKey,
    toDateKey,
    plannedShifts,
    sessions,
    dayOffs,
    toleranceMinutes = 30,
  } = params;

  const dateKeys = enumerateDateKeys(fromDateKey, toDateKey);
  const rows: DailySummaryRow[] = [];

  for (const emp of employees) {
    for (const dateKey of dateKeys) {
      const dayPlanned = plannedShifts.filter(
        (p) => p.employeeId === emp.id && p.madridDateKey === dateKey,
      );
      const daySessions = sessions.filter(
        (s) => s.employeeId === emp.id && s.madridDate === dateKey && s.status !== 'voided',
      );
      const dayOff =
        dayOffs.find((d) => d.madridDate === dateKey && d.employeeId === emp.id) ??
        dayOffs.find((d) => d.madridDate === dateKey && d.employeeId === null) ??
        null;

      const plannedMinutes = dayPlanned.reduce((acc, p) => acc + p.plannedMinutes, 0);
      const workedMinutes = daySessions.reduce((acc, s) => acc + s.workedMinutes, 0);
      const deltaMinutes = workedMinutes - plannedMinutes;
      const isProvisional = daySessions.some((s) => Boolean(s.isProvisionalCap));

      if (plannedMinutes === 0 && workedMinutes === 0 && !dayOff) {
        continue;
      }

      let status: DailySummaryRow['status'] = 'ok';
      if (daySessions.some((s) => s.status === 'incomplete')) {
        status = 'incomplete';
      } else if (daySessions.some((s) => s.status === 'flagged')) {
        status = 'flagged';
      } else if (dayOff && plannedMinutes === 0 && workedMinutes === 0) {
        status = 'day_off';
      } else if (plannedMinutes > 0 && workedMinutes === 0) {
        status = 'absent';
      } else if (
        (plannedMinutes > 0 && Math.abs(deltaMinutes) > toleranceMinutes) ||
        (plannedMinutes === 0 && workedMinutes > 0)
      ) {
        status = 'deviation';
      }

      rows.push({
        employeeId: emp.id,
        employeeName: emp.name,
        externalRef: emp.externalRef,
        madridDate: dateKey,
        plannedMinutes,
        workedMinutes,
        deltaMinutes,
        status,
        isProvisional,
        dayOffType: dayOff?.type ?? null,
      });
    }
  }

  return rows.sort((a, b) => {
    if (a.madridDate !== b.madridDate) return b.madridDate.localeCompare(a.madridDate);
    return a.employeeName.localeCompare(b.employeeName);
  });
}

import {
  buildShiftsFromEvents,
  getEffectiveClockEvents,
  getMadridDateKey,
  sortEventsChronologically,
  validateTransition,
} from './timeEngine.ts';
import { findPlannedShiftForShift } from './planningEngine.ts';
import type {
  AnomalyConfig,
  AnomalyFlag,
  BreakType,
  ClockEvent,
  ClockPolicy,
  CorrectionKind,
  CorrectionPreview,
  CorrectionRequest,
  PlannedShift,
  ProposedCorrectionChange,
  WorkSession,
  WorkState,
} from './types.ts';

export const DEFAULT_CLOCK_POLICY: ClockPolicy = {
  id: 'default',
  pastPlannedEndMinutes: 15,
  flagAfterEndMinutes: 120,
  maxOpenHours: 12,
  maxDailyMinutes: 12 * 60,
  scheduleToleranceMinutes: 30,
  overrunPolicy: 'flag_only',
  requirePlannedShift: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  lateEndOverHours: 2,
  scheduleToleranceMinutes: 30,
  maxOpenHours: 12,
  maxShiftMinutes: 14 * 60,
  pastPlannedEndMinutes: 15,
  flagAfterEndMinutes: 120,
  maxDailyMinutes: 12 * 60,
  overrunPolicy: 'flag_only',
  requirePlannedShift: false,
};

export const ANOMALY_LABELS: Record<AnomalyFlag, string> = {
  past_planned_end: 'Jornada abierta tras fin planificado',
  late_end_over_n_hours: 'Salida muy posterior al fin planificado',
  outside_planned_tolerance: 'Horario fuera de tolerancia planificada',
  open_over_m_hours: 'Jornada abierta demasiado tiempo (incompleta)',
  exceeds_max_shift_hours: 'Duración total superior al máximo razonable',
  no_planned_shift: 'Fichaje sin jornada planificada asignada',
};

export function validateChronologicalSequence(events: ClockEvent[]): {
  ok: boolean;
  reason?: string;
} {
  const { effectiveEvents } = getEffectiveClockEvents(events);
  const sorted = sortEventsChronologically(effectiveEvents);

  let state: WorkState = 'fuera';
  for (const ev of sorted) {
    const check = validateTransition(state, ev.type);
    if (!check.ok) {
      return { ok: false, reason: check.reason };
    }
    if (ev.type === 'shift_start') {
      state = 'en_jornada';
    } else if (ev.type === 'break_start') {
      state = 'en_pausa';
    } else if (ev.type === 'break_end') {
      state = 'en_jornada';
    } else if (ev.type === 'shift_end') {
      state = 'fuera';
    }
  }

  return { ok: true };
}

export function getEventsForDayVoid(
  existingEvents: ClockEvent[],
  madridDateKey: string,
  breakTypes: BreakType[] = [],
  nowMs: number = Date.now(),
): ClockEvent[] {
  const { effectiveEvents } = getEffectiveClockEvents(existingEvents);
  const shifts = buildShiftsFromEvents(existingEvents, breakTypes, nowMs);
  const targetIds = new Set<string>();

  for (const shift of shifts) {
    if (shift.madridDateKey === madridDateKey) {
      for (const ev of shift.events) {
        if (ev.type !== 'event_void') {
          targetIds.add(ev.id);
        }
      }
    }
  }

  for (const ev of effectiveEvents) {
    if (getMadridDateKey(ev.deviceDeclaredAt) === madridDateKey) {
      targetIds.add(ev.id);
    }
  }

  return sortEventsChronologically(effectiveEvents.filter((ev) => targetIds.has(ev.id)));
}

export function simulateCorrectionAndPreview(params: {
  existingEvents: ClockEvent[];
  breakTypes: BreakType[];
  kind: CorrectionKind;
  targetEventId: string | null;
  proposedChange: ProposedCorrectionChange;
  employeeId: string;
  nowMs: number;
}):
  | { ok: true; preview: CorrectionPreview; simulatedEvents: ClockEvent[]; voidDayEvents?: ClockEvent[] }
  | { ok: false; status: number; reason: string } {
  const { existingEvents, breakTypes, kind, targetEventId, proposedChange, employeeId, nowMs } =
    params;

  const { effectiveEvents, voidedEventIds } = getEffectiveClockEvents(existingEvents);
  const targetEvent = targetEventId
    ? existingEvents.find((e) => e.id === targetEventId) ?? null
    : null;

  if (kind === 'void_event' || kind === 'change_time') {
    if (!targetEvent) {
      return { ok: false, status: 404, reason: 'El fichaje original indicado no existe.' };
    }
    if (voidedEventIds.has(targetEvent.id) || targetEvent.type === 'event_void') {
      return {
        ok: false,
        status: 409,
        reason: 'Este fichaje ya ha sido anulado o sustituido por otra corrección.',
      };
    }
  }

  let simulatedEvents: ClockEvent[] = [...effectiveEvents];
  let referenceUtc: string;
  let explicitDateKey: string | null = null;
  let voidDayEvents: ClockEvent[] | undefined;

  if (kind === 'void_day') {
    const dayKey = proposedChange.madridDateKey?.trim() ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
      return { ok: false, status: 422, reason: 'Debes indicar la fecha (YYYY-MM-DD) de la jornada a anular.' };
    }
    const dayEvents = getEventsForDayVoid(existingEvents, dayKey, breakTypes, nowMs);
    if (dayEvents.length === 0) {
      return {
        ok: false,
        status: 422,
        reason: 'No existen fichajes activos para anular en la jornada indicada.',
      };
    }
    const dayIds = new Set(dayEvents.map((e) => e.id));
    simulatedEvents = simulatedEvents.filter((e) => !dayIds.has(e.id));
    explicitDateKey = dayKey;
    referenceUtc = dayEvents[0].deviceDeclaredAt;
    voidDayEvents = dayEvents;
  } else if (kind === 'void_event') {
    referenceUtc = targetEvent!.deviceDeclaredAt;
    simulatedEvents = simulatedEvents.filter((e) => e.id !== targetEvent!.id);
  } else if (kind === 'change_time') {
    if (!proposedChange.declaredAtUtc) {
      return { ok: false, status: 422, reason: 'Debes indicar la nueva fecha y hora.' };
    }
    referenceUtc = proposedChange.declaredAtUtc;
    simulatedEvents = simulatedEvents.map((e) =>
      e.id === targetEvent!.id
        ? {
            ...e,
            deviceDeclaredAt: proposedChange.declaredAtUtc!,
            timeSource: 'device_declared',
            source: 'admin',
            correctsEventId: targetEvent!.id,
          }
        : e,
    );
  } else {
    if (!proposedChange.eventType || proposedChange.eventType === ('event_void' as string)) {
      return { ok: false, status: 422, reason: 'Debes indicar el tipo de fichaje olvidado.' };
    }
    if (!proposedChange.declaredAtUtc) {
      return { ok: false, status: 422, reason: 'Debes indicar la fecha y hora real del fichaje.' };
    }
    referenceUtc = proposedChange.declaredAtUtc;
    simulatedEvents.push({
      id: '00000000-0000-4000-8000-999999999999',
      employeeId,
      type: proposedChange.eventType,
      breakTypeId: proposedChange.breakTypeId ?? null,
      receivedAt: new Date(nowMs).toISOString(),
      deviceDeclaredAt: proposedChange.declaredAtUtc,
      deviceOffsetMs: 0,
      timeSource: 'device_declared',
      source: 'admin',
      correctsEventId: null,
      correctionId: null,
      assignmentRef: proposedChange.assignmentRef ?? null,
      projectRef: proposedChange.projectRef ?? null,
      facilityRef: proposedChange.facilityRef ?? null,
      syncStatus: 'enviado',
      mitaAckRef: null,
    });
  }

  if (kind !== 'void_day') {
    const seqCheck = validateChronologicalSequence(simulatedEvents);
    if (!seqCheck.ok) {
      return {
        ok: false,
        status: 409,
        reason: `La secuencia de fichajes quedaría incoherente: ${seqCheck.reason}`,
      };
    }
  }

  const madridDateKey = explicitDateKey ?? getMadridDateKey(referenceUtc);
  const shiftsBefore = buildShiftsFromEvents(existingEvents, breakTypes, nowMs).filter(
    (s) => s.madridDateKey === madridDateKey,
  );
  const shiftsAfter = buildShiftsFromEvents(simulatedEvents, breakTypes, nowMs).filter(
    (s) => s.madridDateKey === madridDateKey,
  );

  const beforeWorkedMinutes = Math.round(
    shiftsBefore.reduce((sum, s) => sum + s.effectiveMs, 0) / 60000,
  );
  const afterWorkedMinutes = Math.round(
    shiftsAfter.reduce((sum, s) => sum + s.effectiveMs, 0) / 60000,
  );

  return {
    ok: true,
    simulatedEvents,
    voidDayEvents,
    preview: {
      madridDateKey,
      beforeWorkedMinutes,
      afterWorkedMinutes,
      deltaMinutes: afterWorkedMinutes - beforeWorkedMinutes,
    },
  };
}

export function buildWorkSessionsProjection(params: {
  employeeId: string;
  events: ClockEvent[];
  breakTypes: BreakType[];
  plannedShifts: PlannedShift[];
  corrections: CorrectionRequest[];
  config?: AnomalyConfig;
  policy?: ClockPolicy;
  existingSessionsById?: Map<string, WorkSession>;
  nowMs?: number;
}): WorkSession[] {
  const {
    employeeId,
    events,
    breakTypes,
    plannedShifts,
    corrections,
    config = DEFAULT_ANOMALY_CONFIG,
    policy,
    existingSessionsById,
    nowMs = Date.now(),
  } = params;

  const pastPlannedEndMinutes = policy?.pastPlannedEndMinutes ?? config.pastPlannedEndMinutes ?? 15;
  const flagAfterEndMinutes =
    policy?.flagAfterEndMinutes ?? config.flagAfterEndMinutes ?? config.lateEndOverHours * 60;
  const maxOpenHours = policy?.maxOpenHours ?? config.maxOpenHours ?? 12;
  const maxDailyMinutes = policy?.maxDailyMinutes ?? config.maxDailyMinutes ?? 12 * 60;
  const toleranceMinutes = policy?.scheduleToleranceMinutes ?? config.scheduleToleranceMinutes ?? 30;
  const overrunPolicy = policy?.overrunPolicy ?? config.overrunPolicy ?? 'flag_only';

  const shifts = buildShiftsFromEvents(events, breakTypes, nowMs);
  const updatedAt = new Date(nowMs).toISOString();

  return shifts.map((shift, index) => {
    const isLatestShift = index === shifts.length - 1;
    const prevSaved = existingSessionsById?.get(shift.id);

    const shiftEventIds = new Set(shift.events.map((e) => e.id));
    for (const ev of shift.events) {
      if (ev.correctsEventId) shiftEventIds.add(ev.correctsEventId);
    }

    const planned = findPlannedShiftForShift(shift, plannedShifts);
    const sessionDateKey = planned ? planned.madridDateKey : shift.madridDateKey;

    const relatedCorrections = corrections.filter(
      (c) =>
        (c.targetEventId && shiftEventIds.has(c.targetEventId)) ||
        c.preview.madridDateKey === sessionDateKey ||
        c.preview.madridDateKey === shift.madridDateKey,
    );

    const hasPendingCorrection = relatedCorrections.some((c) => c.status === 'pending');
    const hasApprovedCorrection =
      shift.events.some((e) => e.source === 'admin') ||
      relatedCorrections.some((c) => c.status === 'approved');

    const plannedMinutes = planned ? planned.plannedMinutes : 0;
    const rawWorkedMinutes = Math.round(shift.effectiveMs / 60000);
    const breakMinutes = Math.round(shift.breakMs / 60000);

    const anomalyFlags: AnomalyFlag[] = [];
    let status: WorkSession['status'] = shift.isOpen ? 'open' : 'closed';

    const startMs = Date.parse(shift.startUtc);

    if (shift.isOpen) {
      const openHours = (nowMs - startMs) / 3_600_000;
      const exceededMaxOpen = openHours >= maxOpenHours || rawWorkedMinutes >= maxDailyMinutes;

      if (!isLatestShift || exceededMaxOpen) {
        status = 'incomplete';
        anomalyFlags.push('open_over_m_hours');
      } else if (planned) {
        const plannedEndMs = Date.parse(planned.endUtc);
        if (nowMs >= plannedEndMs + flagAfterEndMinutes * 60_000) {
          status = 'flagged';
          anomalyFlags.push('past_planned_end');
          anomalyFlags.push('late_end_over_n_hours');
        } else if (nowMs >= plannedEndMs + pastPlannedEndMinutes * 60_000) {
          anomalyFlags.push('past_planned_end');
        }
      }
    }

    if (rawWorkedMinutes > config.maxShiftMinutes) {
      anomalyFlags.push('exceeds_max_shift_hours');
    }

    if (planned) {
      const toleranceMs = toleranceMinutes * 60_000;
      const plannedStartMs = Date.parse(planned.startUtc);
      const plannedEndMs = Date.parse(planned.endUtc);

      if (Math.abs(startMs - plannedStartMs) > toleranceMs) {
        anomalyFlags.push('outside_planned_tolerance');
      }

      if (shift.endUtc) {
        const actualEndMs = Date.parse(shift.endUtc);
        if (actualEndMs - plannedEndMs > flagAfterEndMinutes * 60_000) {
          if (!anomalyFlags.includes('late_end_over_n_hours')) {
            anomalyFlags.push('late_end_over_n_hours');
          }
        }
        if (
          !anomalyFlags.includes('outside_planned_tolerance') &&
          Math.abs(actualEndMs - plannedEndMs) > toleranceMs
        ) {
          anomalyFlags.push('outside_planned_tolerance');
        }
      }
    } else {
      anomalyFlags.push('no_planned_shift');
    }

    // Política overrun_policy: cap_provisional limita el tiempo efectivo mientras esté abierta y marcada/incompleta
    let workedMinutes = rawWorkedMinutes;
    let isProvisionalCap = false;

    if (
      shift.isOpen &&
      overrunPolicy === 'cap_provisional' &&
      (status === 'flagged' || status === 'incomplete' || anomalyFlags.includes('past_planned_end'))
    ) {
      let capMinutes = maxDailyMinutes;
      if (planned) {
        const plannedEndWithTolMs = Date.parse(planned.endUtc) + toleranceMinutes * 60_000;
        const cappedTotalElapsedMin = Math.max(
          0,
          Math.round((plannedEndWithTolMs - startMs) / 60_000) - breakMinutes,
        );
        capMinutes = Math.min(cappedTotalElapsedMin, planned.plannedMinutes + toleranceMinutes);
      }
      if (rawWorkedMinutes > capMinutes) {
        workedMinutes = Math.max(0, capMinutes);
        isProvisionalCap = true;
      } else if (status === 'flagged' || status === 'incomplete') {
        isProvisionalCap = true;
      }
    }

    const deltaMinutes = workedMinutes - plannedMinutes;

    return {
      id: shift.id,
      employeeId,
      madridDate: sessionDateKey,
      startUtc: shift.startUtc,
      endUtc: shift.endUtc,
      status,
      workedMinutes,
      rawWorkedMinutes,
      plannedMinutes,
      deltaMinutes,
      breakMinutes,
      plannedShiftId: planned?.id ?? null,
      plannedEndUtc: planned?.endUtc ?? null,
      isProvisionalCap,
      overrunAcknowledged: prevSaved?.overrunAcknowledged ?? false,
      overrunReason: prevSaved?.overrunReason ?? null,
      overrunAcknowledgedAt: prevSaved?.overrunAcknowledgedAt ?? null,
      anomalyFlags,
      hasPendingCorrection,
      hasApprovedCorrection,
      updatedAt,
    };
  });
}

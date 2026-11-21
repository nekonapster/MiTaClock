import { describe, it, expect } from 'vitest';
import {
  computeWorkState,
  validateTransition,
  buildShiftsFromEvents,
  getMadridDateKey,
  getMadridMonthKey,
  formatMadridTime,
  formatDurationHms,
} from '../shared/timeEngine';
import type { BreakType, ClockEvent } from '../shared/types';

const breakTypes: BreakType[] = [
  { id: 'bt-1', code: 'DESCANSO', name: 'Descanso reglamentario', isPaid: true, isActive: true },
  { id: 'bt-2', code: 'COMIDA', name: 'Pausa comida', isPaid: false, isActive: true },
];

function makeEvent(
  id: string,
  type: ClockEvent['type'],
  receivedAt: string,
  overrides: Partial<ClockEvent> = {},
): ClockEvent {
  return {
    id,
    employeeId: 'emp-1',
    type,
    breakTypeId: null,
    receivedAt,
    deviceDeclaredAt: receivedAt,
    deviceOffsetMs: 0,
    timeSource: 'server',
    source: 'employee',
    correctsEventId: null,
    correctionId: null,
    assignmentRef: null,
    projectRef: null,
    facilityRef: null,
    syncStatus: 'enviado',
    mitaAckRef: null,
    ...overrides,
  };
}

describe('timeEngine — máquina de estados y cálculo horario', () => {
  it('inicia en estado fuera sin eventos', () => {
    const state = computeWorkState([], Date.parse('2026-11-21T09:00:00.000Z'));
    expect(state.workState).toBe('fuera');
    expect(state.effectiveMs).toBe(0);
    expect(state.breakMs).toBe(0);
    expect(state.activeShiftStart).toBeNull();
  });

  it('transiciona fuera -> en_jornada -> en_pausa -> en_jornada -> fuera y descuenta pausas', () => {
    const events: ClockEvent[] = [
      makeEvent('e1', 'shift_start', '2026-11-21T08:00:00.000Z'),
      makeEvent('e2', 'break_start', '2026-11-21T10:00:00.000Z', { breakTypeId: 'bt-1' }),
      makeEvent('e3', 'break_end', '2026-11-21T10:15:00.000Z'),
    ];

    const duringResume = computeWorkState(events, Date.parse('2026-11-21T11:15:00.000Z'));
    expect(duringResume.workState).toBe('en_jornada');
    // 3h15m totales - 15m de pausa = 3h00m (10800000 ms)
    expect(duringResume.effectiveMs).toBe(3 * 60 * 60 * 1000);
    expect(duringResume.breakMs).toBe(15 * 60 * 1000);
    expect(duringResume.breaksCompleted).toHaveLength(1);

    // Durante una segunda pausa, el tiempo efectivo permanece congelado
    const eventsInBreak = [
      ...events,
      makeEvent('e4', 'break_start', '2026-11-21T11:15:00.000Z', { breakTypeId: 'bt-2' }),
    ];
    const paused = computeWorkState(eventsInBreak, Date.parse('2026-11-21T11:45:00.000Z'));
    expect(paused.workState).toBe('en_pausa');
    expect(paused.effectiveMs).toBe(3 * 60 * 60 * 1000);
    expect(paused.breakMs).toBe(45 * 60 * 1000);
  });

  it('valida transiciones permitidas y rechaza inválidas', () => {
    expect(validateTransition('fuera', 'shift_start').ok).toBe(true);
    expect(validateTransition('fuera', 'break_start').ok).toBe(false);
    expect(validateTransition('fuera', 'shift_end').ok).toBe(false);

    expect(validateTransition('en_jornada', 'break_start').ok).toBe(true);
    expect(validateTransition('en_jornada', 'shift_end').ok).toBe(true);
    expect(validateTransition('en_jornada', 'shift_start').ok).toBe(false);
    expect(validateTransition('en_jornada', 'break_end').ok).toBe(false);

    expect(validateTransition('en_pausa', 'break_end').ok).toBe(true);
    // Permitimos shift_end desde en_pausa (el servidor/UI cierra la pausa primero)
    expect(validateTransition('en_pausa', 'shift_end').ok).toBe(true);
    expect(validateTransition('en_pausa', 'break_start').ok).toBe(false);
  });

  it('atribuye el día y la hora correctamente en Europe/Madrid desde timestamps UTC', () => {
    // 23:30 UTC en noviembre (CET = UTC+1) es 00:30 del día siguiente en Madrid
    const utcLateNight = '2026-11-20T23:30:00.000Z';
    expect(getMadridDateKey(utcLateNight)).toBe('2026-11-21');
    expect(getMadridMonthKey(utcLateNight)).toBe('2026-11');
    expect(formatMadridTime(utcLateNight)).toBe('00:30');
    expect(formatDurationHms(3661000)).toBe('01:01:01');
  });

  it('agrupa jornadas y calcula estado de sincronización agregado (pendiente < enviado < confirmado)', () => {
    const events: ClockEvent[] = [
      makeEvent('e1', 'shift_start', '2026-11-21T07:00:00.000Z', { syncStatus: 'confirmado' }),
      makeEvent('e2', 'break_start', '2026-11-21T09:00:00.000Z', { breakTypeId: 'bt-1', syncStatus: 'confirmado' }),
      makeEvent('e3', 'break_end', '2026-11-21T09:20:00.000Z', { syncStatus: 'enviado' }),
      makeEvent('e4', 'shift_end', '2026-11-21T15:20:00.000Z', { syncStatus: 'pendiente' }),
    ];

    const shifts = buildShiftsFromEvents(events, breakTypes, Date.parse('2026-11-21T16:00:00.000Z'));
    expect(shifts).toHaveLength(1);
    expect(shifts[0].effectiveMs).toBe(8 * 60 * 60 * 1000);
    expect(shifts[0].breakMs).toBe(20 * 60 * 1000);
    expect(shifts[0].syncStatus).toBe('pendiente');
    expect(shifts[0].breaks[0].breakTypeName).toBe('Descanso reglamentario');
  });
});

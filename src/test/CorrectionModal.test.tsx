// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CorrectionModal } from '../client/components/CorrectionModal';
import type { BreakType, ClockEvent } from '../shared/types';

const breakTypes: BreakType[] = [
  { id: 'bt-1', code: 'DESCANSO', name: 'Descanso reglamentario', isPaid: true, isActive: true },
];

const yesterdayBase = new Date(Date.now() - 24 * 60 * 60 * 1000);
const yKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(yesterdayBase);

const startIso = new Date(`${yKey}T07:00:00.000Z`).toISOString();
const endIso = new Date(`${yKey}T17:00:00.000Z`).toISOString(); // 10 horas después

const baseEvents: ClockEvent[] = [
  {
    id: 'ev-start',
    employeeId: 'emp-1',
    type: 'shift_start',
    breakTypeId: null,
    receivedAt: startIso,
    deviceDeclaredAt: startIso,
    deviceOffsetMs: 0,
    timeSource: 'server',
    assignmentRef: null,
    projectRef: null,
    facilityRef: null,
    syncStatus: 'confirmado',
    mitaAckRef: null,
    source: 'employee',
    correctsEventId: null,
    correctionId: null,
  },
  {
    id: 'ev-end',
    employeeId: 'emp-1',
    type: 'shift_end',
    breakTypeId: null,
    receivedAt: endIso,
    deviceDeclaredAt: endIso,
    deviceOffsetMs: 0,
    timeSource: 'server',
    assignmentRef: null,
    projectRef: null,
    facilityRef: null,
    syncStatus: 'confirmado',
    mitaAckRef: null,
    source: 'employee',
    correctsEventId: null,
    correctionId: null,
  },
];

describe('CorrectionModal — vista previa en vivo y validaciones', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('muestra la vista previa recalculada y valida motivo mínimo y secuencia coherente', async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <CorrectionModal
        open={true}
        employeeId="emp-1"
        targetEvent={baseEvents[1]}
        existingEvents={baseEvents}
        breakTypes={breakTypes}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );

    const preview = screen.getByTestId('correction-preview');
    expect(preview.textContent).toMatch(/Tu jornada pasaría de/i);
    expect(preview.textContent).toMatch(/10 h 00 min/i);

    // Cambiar hora de salida 4 horas antes (ej. de 18:00 a 14:00)
    const timeInput = screen.getByLabelText(/Hora real \(Madrid\)/i) as HTMLInputElement;
    const origHour = Number(timeInput.value.split(':')[0]);
    const newHour = String(origHour - 4).padStart(2, '0');
    fireEvent.change(timeInput, { target: { value: `${newHour}:00` } });

    expect(screen.getByTestId('correction-preview').textContent).toMatch(/6 h 00 min/i);

    // Si ponemos una hora incoherente (fin antes del inicio), bloquea el envío
    const invalidHour = String(Math.max(0, origHour - 12)).padStart(2, '0');
    fireEvent.change(timeInput, { target: { value: `${invalidHour}:00` } });
    const submitBtn = screen.getByRole('button', { name: /Enviar solicitud/i }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    // Restaurar a hora válida (-4h) y probar envío con motivo válido (>=10 chars)
    fireEvent.change(timeInput, { target: { value: `${newHour}:00` } });
    expect(submitBtn.disabled).toBe(false);

    const reasonInput = screen.getByLabelText(/Motivo/i);
    fireEvent.change(reasonInput, {
      target: { value: 'Salí a las 14:00 al finalizar la clase de natación.' },
    });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      employeeId: 'emp-1',
      targetEventId: 'ev-end',
      kind: 'change_time',
    });
  });

  it('permite solicitar la anulación de la jornada completa (void_day) mostrando los eventos afectados', async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <CorrectionModal
        open={true}
        employeeId="emp-1"
        targetEvent={null}
        initialKind="void_day"
        initialDateKey={yKey}
        existingEvents={baseEvents}
        breakTypes={breakTypes}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );

    const eventsList = screen.getByTestId('void-day-events-list');
    expect(eventsList.textContent).toContain('2 registro(s)');

    const preview = screen.getByTestId('correction-preview');
    expect(preview.textContent).toMatch(/10 h 00 min/i);
    expect(preview.textContent).toMatch(/0 h 00 min/i);

    const reasonInput = screen.getByLabelText(/Motivo/i);
    fireEvent.change(reasonInput, {
      target: { value: 'Fichajes registrados por error durante día libre compensado.' },
    });

    const submitBtn = screen.getByRole('button', { name: /Enviar solicitud/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      employeeId: 'emp-1',
      targetEventId: null,
      kind: 'void_day',
      proposedChange: { madridDateKey: yKey },
    });
  });
});

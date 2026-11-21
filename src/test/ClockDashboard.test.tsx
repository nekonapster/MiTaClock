// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ClockDashboard } from '../client/components/ClockDashboard';
import { formatMadridTime } from '../shared/timeEngine';
import type { PlannedShift, WorkSession, WorkStateSnapshot } from '../shared/types';

describe('ClockDashboard — jornada planificada y aviso de fin de jornada', () => {
  const startUtc = '2026-11-21T07:00:00.000Z';
  const endUtc = '2026-11-21T14:00:00.000Z';

  const plannedShift: PlannedShift = {
    id: 'ps-1',
    employeeId: 'emp-1',
    madridDateKey: '2026-11-21',
    startUtc,
    endUtc,
    plannedBreakMinutes: 0,
    plannedMinutes: 420,
    projectRef: 'OP-DIARIA',
    facilityRef: 'CENTRO-01',
    assignmentRef: null,
    source: 'local',
    label: 'Turno mañana',
    createdAt: startUtc,
    updatedAt: startUtc,
  };

  const activeSession: WorkSession = {
    id: 'sess-1',
    employeeId: 'emp-1',
    madridDate: '2026-11-21',
    startUtc,
    endUtc: null,
    workedMinutes: 440,
    rawWorkedMinutes: 440,
    breakMinutes: 0,
    deltaMinutes: 20,
    status: 'open',
    anomalyFlags: ['past_planned_end'],
    hasPendingCorrection: false,
    hasApprovedCorrection: false,
    plannedShiftId: 'ps-1',
    plannedEndUtc: endUtc,
    plannedMinutes: 420,
    overrunAcknowledged: false,
    overrunReason: null,
    isProvisionalCap: false,
    updatedAt: endUtc,
  };

  const snapshot: WorkStateSnapshot = {
    workState: 'en_jornada',
    activeShiftStart: startUtc,
    activeBreakStart: null,
    activeBreakTypeId: null,
    effectiveMs: 440 * 60_000,
    breakMs: 0,
    breaksCompleted: [],
    openBreak: null,
    activeAssignmentRef: null,
    activeProjectRef: 'OP-DIARIA',
    activeFacilityRef: 'CENTRO-01',
  };

  it('muestra el resumen de jornada planificada, barra de progreso y permite responder Sigo trabajando', async () => {
    const onAcknowledgeOverrun = vi.fn().mockResolvedValue(undefined);
    const startLabel = formatMadridTime(startUtc);
    const endLabel = formatMadridTime(endUtc);

    render(
      <ClockDashboard
        employeeName="Laura Gómez"
        externalRef="MITA-101"
        snapshot={snapshot}
        breakTypes={[]}
        plannedShifts={[plannedShift]}
        todayPlannedShift={plannedShift}
        activeSession={activeSession}
        showOverrunPrompt={true}
        overrunMinutes={20}
        anomalySessions={[]}
        queuedCount={0}
        isOnline={true}
        syncing={false}
        actionBusy={false}
        errorMessage={null}
        onClockAction={vi.fn()}
        onConfirmFinishShift={vi.fn()}
        onSyncNow={vi.fn()}
        onReviewAnomaly={vi.fn()}
        onAcknowledgeOverrun={onAcknowledgeOverrun}
      />,
    );

    expect(
      screen.getByText(new RegExp(`Tu jornada de hoy: ${startLabel} a ${endLabel} \\(7 h\\)`)),
    ).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(
      screen.getByText(new RegExp(`Tu jornada prevista terminó a las ${endLabel}\\. ¿Sigues trabajando\\?`)),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sigo trabajando' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turno ampliado autorizado' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar continuidad' }));

    await waitFor(() => {
      expect(onAcknowledgeOverrun).toHaveBeenCalledWith('sess-1', 'Turno ampliado autorizado');
    });
  });

  it('muestra etiqueta Provisional, pendiente de revisión cuando hay tope provisional activo', () => {
    render(
      <ClockDashboard
        employeeName="Laura Gómez"
        externalRef="MITA-101"
        snapshot={snapshot}
        breakTypes={[]}
        plannedShifts={[plannedShift]}
        todayPlannedShift={plannedShift}
        activeSession={{
          ...activeSession,
          status: 'flagged',
          isProvisionalCap: true,
          workedMinutes: 420,
        }}
        showOverrunPrompt={false}
        overrunMinutes={0}
        anomalySessions={[]}
        queuedCount={0}
        isOnline={true}
        syncing={false}
        actionBusy={false}
        errorMessage={null}
        onClockAction={vi.fn()}
        onConfirmFinishShift={vi.fn()}
        onSyncNow={vi.fn()}
        onReviewAnomaly={vi.fn()}
      />,
    );

    expect(screen.getByText(/Provisional, pendiente de revisión/i)).toBeInTheDocument();
  });
});

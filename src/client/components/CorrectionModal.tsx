import React, { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import {
  formatMadridDateTimeInput,
  formatMadridTime,
  formatMinutesShort,
  getMadridDateKey,
  madridLocalToUtcIso,
} from '../../shared/timeEngine';
import { getEventsForDayVoid, simulateCorrectionAndPreview } from '../../shared/correctionsEngine';
import type {
  BreakType,
  ClockEvent,
  ClockEventType,
  CorrectionKind,
  Employee,
  ProposedCorrectionChange,
} from '../../shared/types';

export interface CorrectionModalProps {
  open: boolean;
  employeeId: string;
  targetEvent: ClockEvent | null;
  initialKind?: CorrectionKind;
  initialDateKey?: string;
  initialEventType?: Exclude<ClockEventType, 'event_void'>;
  existingEvents: ClockEvent[];
  breakTypes: BreakType[];
  // Solo en modo admin para crear en nombre de un empleado
  adminEmployees?: Employee[];
  onSelectEmployeeId?: (employeeId: string) => void;
  onClose: () => void;
  onSubmit: (payload: {
    employeeId: string;
    targetEventId: string | null;
    kind: CorrectionKind;
    reason: string;
    proposedChange?: ProposedCorrectionChange;
  }) => Promise<void>;
}

const EVENT_TYPE_LABELS: Record<Exclude<ClockEventType, 'event_void'>, string> = {
  shift_start: 'Inicio de jornada',
  shift_end: 'Fin de jornada',
  break_start: 'Inicio de pausa',
  break_end: 'Fin de pausa',
};

export const CorrectionModal: React.FC<CorrectionModalProps> = ({
  open,
  employeeId,
  targetEvent,
  initialKind,
  initialDateKey,
  initialEventType,
  existingEvents,
  breakTypes,
  adminEmployees,
  onSelectEmployeeId,
  onClose,
  onSubmit,
}) => {
  const [kind, setKind] = useState<CorrectionKind>(
    initialKind ?? (targetEvent ? 'change_time' : 'add_event'),
  );
  const [eventType, setEventType] = useState<Exclude<ClockEventType, 'event_void'>>(
    initialEventType ?? 'shift_end',
  );
  const [madridDate, setMadridDate] = useState('');
  const [madridTime, setMadridTime] = useState('14:00');
  const [breakTypeId, setBreakTypeId] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    setReason('');
    if (targetEvent) {
      setKind(initialKind === 'void_event' ? 'void_event' : 'change_time');
      const dt = formatMadridDateTimeInput(targetEvent.deviceDeclaredAt);
      setMadridDate(dt.date);
      setMadridTime(dt.time);
    } else {
      setKind(initialKind === 'void_day' ? 'void_day' : 'add_event');
      setEventType(initialEventType ?? 'shift_end');
      setMadridDate(initialDateKey ?? getMadridDateKey(new Date().toISOString()));
      setMadridTime('14:00');
    }
    if (breakTypes.length > 0) {
      setBreakTypeId((prev) => prev || breakTypes[0].id);
    }
  }, [open, targetEvent, initialKind, initialDateKey, initialEventType, breakTypes]);

  const dayEventsToVoid = useMemo(() => {
    if (!open || kind !== 'void_day' || !madridDate) return [];
    return getEventsForDayVoid(existingEvents, madridDate, breakTypes, Date.now());
  }, [open, kind, madridDate, existingEvents, breakTypes]);

  const proposedChange = useMemo<ProposedCorrectionChange | undefined>(() => {
    if (kind === 'void_event') return undefined;
    if (kind === 'void_day') {
      return madridDate ? { madridDateKey: madridDate } : undefined;
    }
    if (!madridDate || !madridTime) return undefined;
    const declaredAtUtc = madridLocalToUtcIso(madridDate, madridTime);
    return {
      eventType: kind === 'add_event' ? eventType : undefined,
      declaredAtUtc,
      breakTypeId:
        kind === 'add_event' && eventType === 'break_start' ? breakTypeId || null : null,
    };
  }, [kind, madridDate, madridTime, eventType, breakTypeId]);

  const previewResult = useMemo(() => {
    if (!open) return null;
    if (kind === 'void_day' && !madridDate) return null;
    if ((kind === 'change_time' || kind === 'add_event') && !proposedChange?.declaredAtUtc) {
      return null;
    }
    return simulateCorrectionAndPreview({
      existingEvents,
      breakTypes,
      kind,
      targetEventId: targetEvent?.id ?? null,
      proposedChange: proposedChange ?? {},
      employeeId,
      nowMs: Date.now(),
    });
  }, [open, existingEvents, breakTypes, kind, targetEvent, proposedChange, employeeId, madridDate]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    if (reason.trim().length < 10) {
      setSubmitError('El motivo debe tener al menos 10 caracteres.');
      return;
    }

    if (previewResult && !previewResult.ok) {
      setSubmitError(previewResult.reason);
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        employeeId,
        targetEventId: kind === 'add_event' || kind === 'void_day' ? null : targetEvent?.id ?? null,
        kind,
        reason: reason.trim(),
        proposedChange,
      });
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'No se pudo enviar la solicitud.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="correction-modal-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/55 p-0 sm:p-4 backdrop-blur-xs"
    >
      <div className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="correction-modal-title" className="text-xl font-bold text-slate-900">
              {targetEvent
                ? 'Solicitar corrección de fichaje'
                : kind === 'void_day'
                  ? 'Anular jornada completa'
                  : 'Añadir fichaje olvidado'}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              El evento original nunca se borra. Si se aprueba, se emitirá un evento compensatorio.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {adminEmployees && adminEmployees.length > 0 && onSelectEmployeeId && (
            <div>
              <label htmlFor="corr-emp" className="block text-xs font-medium text-slate-700">
                Empleado
              </label>
              <select
                id="corr-emp"
                value={employeeId}
                onChange={(e) => onSelectEmployeeId(e.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              >
                {adminEmployees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name} ({emp.email})
                  </option>
                ))}
              </select>
            </div>
          )}

          {targetEvent && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
              <p className="font-semibold text-slate-900">
                Fichaje original:{' '}
                {EVENT_TYPE_LABELS[targetEvent.type as Exclude<ClockEventType, 'event_void'>] ??
                  targetEvent.type}
              </p>
              <p className="mt-0.5 font-mono tabular-nums">
                Hora registrada (Madrid): {formatMadridTime(targetEvent.deviceDeclaredAt)} ·{' '}
                {getMadridDateKey(targetEvent.deviceDeclaredAt)}
              </p>
            </div>
          )}

          {targetEvent ? (
            <div>
              <p className="block text-xs font-medium text-slate-700 mb-1.5">Tipo de corrección</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setKind('change_time')}
                  className={`min-h-[44px] rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                    kind === 'change_time'
                      ? 'border-blue-600 bg-blue-50 text-blue-800'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Cambiar hora real
                </button>
                <button
                  type="button"
                  onClick={() => setKind('void_event')}
                  className={`min-h-[44px] rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                    kind === 'void_event'
                      ? 'border-rose-600 bg-rose-50 text-rose-800'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Anular fichaje erróneo
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <p className="block text-xs font-medium text-slate-700 mb-1.5">Tipo de solicitud</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setKind('add_event')}
                    className={`min-h-[44px] rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                      kind === 'add_event'
                        ? 'border-blue-600 bg-blue-50 text-blue-800'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    Añadir fichaje olvidado
                  </button>
                  <button
                    type="button"
                    onClick={() => setKind('void_day')}
                    className={`min-h-[44px] rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                      kind === 'void_day'
                        ? 'border-rose-600 bg-rose-50 text-rose-800'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    Anular jornada completa
                  </button>
                </div>
              </div>

              {kind === 'add_event' && (
                <div>
                  <label htmlFor="corr-event-type" className="block text-xs font-medium text-slate-700">
                    Tipo de fichaje olvidado
                  </label>
                  <select
                    id="corr-event-type"
                    value={eventType}
                    onChange={(e) =>
                      setEventType(e.target.value as Exclude<ClockEventType, 'event_void'>)
                    }
                    className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                  >
                    <option value="shift_start">Inicio de jornada</option>
                    <option value="shift_end">Fin de jornada</option>
                    <option value="break_start">Inicio de pausa</option>
                    <option value="break_end">Fin de pausa</option>
                  </select>
                </div>
              )}
            </div>
          )}

          {kind === 'add_event' && eventType === 'break_start' && breakTypes.length > 0 && (
            <div>
              <label htmlFor="corr-break-type" className="block text-xs font-medium text-slate-700">
                Tipo de pausa
              </label>
              <select
                id="corr-break-type"
                value={breakTypeId}
                onChange={(e) => setBreakTypeId(e.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              >
                {breakTypes.map((bt) => (
                  <option key={bt.id} value={bt.id}>
                    {bt.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {kind === 'void_day' && (
            <div className="space-y-3">
              <div>
                <label htmlFor="corr-date" className="block text-xs font-medium text-slate-700">
                  Fecha de la jornada a anular (Europe/Madrid)
                </label>
                <input
                  id="corr-date"
                  type="date"
                  required
                  value={madridDate}
                  onChange={(e) => setMadridDate(e.target.value)}
                  className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900"
                />
              </div>

              {dayEventsToVoid.length > 0 && (
                <div
                  data-testid="void-day-events-list"
                  className="rounded-xl border border-rose-200 bg-rose-50/70 px-4 py-3 text-xs text-rose-950 space-y-1.5"
                >
                  <p className="font-semibold">
                    Se enviará una única petición para anular los {dayEventsToVoid.length} registro(s) del día {madridDate}:
                  </p>
                  <ul className="space-y-1 font-mono tabular-nums text-[11px] text-rose-900">
                    {dayEventsToVoid.map((ev) => (
                      <li key={ev.id}>
                        • {EVENT_TYPE_LABELS[ev.type as Exclude<ClockEventType, 'event_void'>] ?? ev.type} ·{' '}
                        {formatMadridTime(ev.deviceDeclaredAt)} ({getMadridDateKey(ev.deviceDeclaredAt)})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {(kind === 'change_time' || kind === 'add_event') && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="corr-date" className="block text-xs font-medium text-slate-700">
                  Fecha (Europe/Madrid)
                </label>
                <input
                  id="corr-date"
                  type="date"
                  required
                  value={madridDate}
                  onChange={(e) => setMadridDate(e.target.value)}
                  className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900"
                />
              </div>
              <div>
                <label htmlFor="corr-time" className="block text-xs font-medium text-slate-700">
                  Hora real (Madrid)
                </label>
                <input
                  id="corr-time"
                  type="time"
                  required
                  value={madridTime}
                  onChange={(e) => setMadridTime(e.target.value)}
                  className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono text-slate-900"
                />
              </div>
            </div>
          )}

          {previewResult && (
            <div
              data-testid="correction-preview"
              className={`rounded-xl border px-4 py-3 text-sm ${
                previewResult.ok
                  ? 'border-blue-200 bg-blue-50/70 text-blue-950'
                  : 'border-rose-200 bg-rose-50 text-rose-900'
              }`}
            >
              {previewResult.ok ? (
                <>
                  <p className="font-semibold">
                    Tu jornada pasaría de{' '}
                    <span className="font-mono tabular-nums">
                      {formatMinutesShort(previewResult.preview.beforeWorkedMinutes)}
                    </span>{' '}
                    a{' '}
                    <span className="font-mono tabular-nums">
                      {formatMinutesShort(previewResult.preview.afterWorkedMinutes)}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-blue-800">
                    Hora declarada por empleado · Sujeta a aprobación de un administrador.
                  </p>
                </>
              ) : (
                <p className="font-medium text-xs">{previewResult.reason}</p>
              )}
            </div>
          )}

          <div>
            <label htmlFor="corr-reason" className="block text-xs font-medium text-slate-700">
              Motivo (obligatorio, mínimo 10 caracteres)
            </label>
            <textarea
              id="corr-reason"
              required
              minLength={10}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ej. Salí a las 14:00 al acabar la clase y olvidé pulsar Finalizar hasta llegar a casa."
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-slate-500 tabular-nums">
              {reason.trim().length}/10 caracteres mínimos
            </p>
          </div>

          {submitError && (
            <div
              role="alert"
              className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800"
            >
              {submitError}
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="min-h-[46px] flex-1 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting || (previewResult !== null && !previewResult.ok)}
              className="min-h-[46px] flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Enviando...' : 'Enviar solicitud'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

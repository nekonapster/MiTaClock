import React, { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { formatDurationHms, formatDurationShort, formatMadridTime } from '../../shared/timeEngine';
import type { ShiftBreakSummary } from '../../shared/types';

export interface FinishShiftModalProps {
  open: boolean;
  shiftStartUtc: string | null;
  effectiveMs: number;
  breakMs: number;
  breaks: ShiftBreakSummary[];
  isOnBreak: boolean;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const FinishShiftModal: React.FC<FinishShiftModalProps> = ({
  open,
  shiftStartUtc,
  effectiveMs,
  breakMs,
  breaks,
  isOnBreak,
  submitting,
  onCancel,
  onConfirm,
}) => {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) {
      cancelButtonRef.current?.focus();
    }
  }, [open]);

  if (!open || !shiftStartUtc) {
    return null;
  }

  return (
    <div
      data-testid="finish-shift-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="finish-shift-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/55 p-0 sm:p-4 backdrop-blur-xs"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
      >
        <h2 id="finish-shift-title" className="text-xl font-bold text-slate-900">
          Confirmar fin de jornada
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Revisa el resumen antes de registrar la salida definitiva.
        </p>

        {isOnBreak && (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-sm text-amber-950">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
            <div>
              <p className="font-semibold">Pausa en curso</p>
              <p className="mt-0.5 text-xs text-amber-900">
                La pausa activa se cerrará automáticamente al finalizar la jornada.
              </p>
            </div>
          </div>
        )}

        <dl className="mt-5 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-slate-50/70 px-4">
          <div className="flex items-center justify-between py-3 text-sm">
            <dt className="text-slate-600">Hora de inicio</dt>
            <dd className="font-mono font-semibold text-slate-900 tabular-nums">
              {formatMadridTime(shiftStartUtc)}
            </dd>
          </div>
          <div className="flex items-center justify-between py-3 text-sm">
            <dt className="text-slate-600">Tiempo efectivo</dt>
            <dd className="font-mono font-bold text-blue-700 tabular-nums">
              {formatDurationHms(effectiveMs)}
            </dd>
          </div>
          <div className="flex items-center justify-between py-3 text-sm">
            <dt className="text-slate-600">Pausas totales ({breaks.length})</dt>
            <dd className="font-mono font-medium text-slate-800 tabular-nums">
              {formatDurationShort(breakMs)}
            </dd>
          </div>
        </dl>

        {breaks.length > 0 && (
          <div className="mt-3 max-h-32 overflow-y-auto rounded-xl border border-slate-100 bg-white px-3 py-2">
            <ul className="divide-y divide-slate-100 text-xs text-slate-600">
              {breaks.map((b) => (
                <li key={b.id} className="flex items-center justify-between py-1.5">
                  <span className="truncate pr-2 font-medium text-slate-700">
                    {b.breakTypeName}
                    {b.isOpen ? ' (abierta)' : ''}
                  </span>
                  <span className="font-mono tabular-nums whitespace-nowrap">
                    {formatMadridTime(b.startUtc)}
                    {b.endUtc ? ` – ${formatMadridTime(b.endUtc)}` : ' – ahora'} ·{' '}
                    {formatDurationShort(b.durationMs)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-6 flex flex-col-reverse sm:flex-row gap-3">
          <button
            ref={cancelButtonRef}
            type="button"
            disabled={submitting}
            onClick={onCancel}
            className="min-h-[48px] flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={onConfirm}
            className="min-h-[48px] flex-1 rounded-xl bg-rose-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-rose-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 disabled:opacity-50"
          >
            {submitting ? 'Registrando...' : 'Sí, finalizar jornada'}
          </button>
        </div>
      </div>
    </div>
  );
};

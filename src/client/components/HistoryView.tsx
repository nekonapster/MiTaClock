import React, { useMemo, useState } from 'react';
import { Clock, Edit3, PlusCircle, Trash2, XCircle } from 'lucide-react';
import {
  formatDurationShort,
  formatMadridDateLabel,
  formatMadridTime,
  formatMinutesShort,
  getEffectiveClockEvents,
  getMadridDateKey,
} from '../../shared/timeEngine';
import { ANOMALY_LABELS } from '../../shared/correctionsEngine';
import type {
  ClockEvent,
  CorrectionRequest,
  HistoryPeriod,
  ShiftSummary,
  SyncStatus,
  WorkSession,
} from '../../shared/types';

interface HistoryViewProps {
  shifts: ShiftSummary[];
  allEvents: ClockEvent[];
  sessions: WorkSession[];
  corrections: CorrectionRequest[];
  onRequestCorrectionForEvent: (event: ClockEvent) => void;
  onForgotClockIn: () => void;
  onRequestVoidDay: (madridDateKey?: string) => void;
  onCancelCorrection: (correctionId: string) => Promise<void>;
}

const SYNC_STATUS_TEXT: Record<SyncStatus, { label: string; colorClass: string }> = {
  pendiente: { label: 'Pendiente (local)', colorClass: 'text-amber-700 font-semibold' },
  enviado: { label: 'Enviado al servidor', colorClass: 'text-blue-700 font-semibold' },
  confirmado: { label: 'Confirmado en MiTa', colorClass: 'text-emerald-700 font-semibold' },
};

const EVENT_LABELS: Record<ClockEvent['type'], string> = {
  shift_start: 'Inicio de jornada',
  shift_end: 'Fin de jornada',
  break_start: 'Inicio de pausa',
  break_end: 'Fin de pausa',
  event_void: 'Anulación compensatoria',
};

const CORRECTION_STATUS_LABELS: Record<
  CorrectionRequest['status'],
  { label: string; cls: string }
> = {
  pending: { label: 'Pendiente', cls: 'text-amber-700 font-semibold' },
  approved: { label: 'Aprobada', cls: 'text-emerald-700 font-semibold' },
  rejected: { label: 'Rechazada', cls: 'text-rose-700 font-semibold' },
  cancelled: { label: 'Cancelada', cls: 'text-slate-500 font-medium' },
};

export const HistoryView: React.FC<HistoryViewProps> = ({
  shifts,
  allEvents,
  sessions,
  corrections,
  onRequestCorrectionForEvent,
  onForgotClockIn,
  onRequestVoidDay,
  onCancelCorrection,
}) => {
  const [period, setPeriod] = useState<HistoryPeriod>('day');
  const [expandedCorrId, setExpandedCorrId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const { voidedEventIds } = useMemo(() => getEffectiveClockEvents(allEvents), [allEvents]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, ClockEvent[]>();
    for (const ev of allEvents) {
      const dateKey = getMadridDateKey(ev.deviceDeclaredAt);
      const list = map.get(dateKey) ?? [];
      list.push(ev);
      map.set(dateKey, list);
    }
    return map;
  }, [allEvents]);

  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  const grouped = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        label: string;
        totalEffectiveMs: number;
        totalBreakMs: number;
        items: ShiftSummary[];
      }
    >();

    const sortedShifts = [...shifts].sort((a, b) => Date.parse(b.startUtc) - Date.parse(a.startUtc));

    for (const shift of sortedShifts) {
      let key = shift.madridDateKey;
      let label = formatMadridDateLabel(shift.startUtc);

      if (period === 'week') {
        key = shift.madridWeekKey;
        const [year, week] = key.split('-W');
        label = `Semana ${week} · ${year}`;
      } else if (period === 'month') {
        key = shift.madridMonthKey;
        const formatted = new Intl.DateTimeFormat('es-ES', {
          timeZone: 'Europe/Madrid',
          month: 'long',
          year: 'numeric',
        }).format(new Date(shift.startUtc));
        label = formatted.charAt(0).toUpperCase() + formatted.slice(1);
      }

      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          key,
          label,
          totalEffectiveMs: shift.effectiveMs,
          totalBreakMs: shift.breakMs,
          items: [shift],
        });
      } else {
        existing.totalEffectiveMs += shift.effectiveMs;
        existing.totalBreakMs += shift.breakMs;
        existing.items.push(shift);
      }
    }

    return Array.from(map.values());
  }, [shifts, period]);

  const handleCancel = async (id: string) => {
    setCancellingId(id);
    try {
      await onCancelCorrection(id);
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Historial de jornadas</h1>
          <p className="mt-1 text-xs text-slate-500">
            Atribución y horarios mostrados en zona Europe/Madrid. Los originales nunca se ocultan.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onForgotClockIn}
            className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-blue-700 whitespace-nowrap"
          >
            <PlusCircle className="h-4 w-4" aria-hidden="true" />
            Olvidé fichar
          </button>

          <button
            type="button"
            onClick={() => onRequestVoidDay()}
            className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-rose-300 bg-white px-4 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 whitespace-nowrap"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Anular jornada completa
          </button>

          <div
            role="tablist"
            aria-label="Agrupación del historial"
            className="inline-flex items-center gap-1 rounded-xl bg-slate-200/70 p-1"
          >
            {(
              [
                { id: 'day', label: 'Día' },
                { id: 'week', label: 'Semana' },
                { id: 'month', label: 'Mes' },
              ] as const
            ).map((tab) => {
              const active = period === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setPeriod(tab.id)}
                  className={`min-h-[38px] rounded-lg px-4 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                    active
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {grouped.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
          <p className="text-sm font-medium text-slate-700">Todavía no hay jornadas activas.</p>
          <p className="mt-1 text-xs text-slate-500">
            Si olvidaste fichar una entrada o salida anterior, usa «Olvidé fichar».
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {grouped.map((group) => (
            <section
              key={group.key}
              className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-xs"
            >
              <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-5 py-3.5">
                <h2 className="text-sm font-semibold text-slate-900">{group.label}</h2>
                <p className="text-xs text-slate-600 font-mono tabular-nums">
                  Efectivo: <strong className="text-slate-900">{formatDurationShort(group.totalEffectiveMs)}</strong>
                  {' · '}
                  Pausas: {formatDurationShort(group.totalBreakMs)}
                </p>
              </header>

              <ul className="divide-y divide-slate-100">
                {group.items.map((shift) => {
                  const statusInfo = SYNC_STATUS_TEXT[shift.syncStatus];
                  const ws = sessionById.get(shift.id);
                  const dayEvents = eventsByDate.get(shift.madridDateKey) ?? shift.events;
                  const activeDayEvents = dayEvents.filter(
                    (ev) => !voidedEventIds.has(ev.id) && ev.type !== 'event_void',
                  );
                  const hasUnsynced = activeDayEvents.some((ev) => ev.syncStatus === 'pendiente');
                  const pendingVoidDay = corrections.find(
                    (c) =>
                      c.kind === 'void_day' &&
                      c.status === 'pending' &&
                      c.proposedChange.madridDateKey === shift.madridDateKey,
                  );

                  return (
                    <li key={shift.id} className="px-5 py-4 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm font-semibold text-slate-900 font-mono tabular-nums">
                          {formatMadridTime(shift.startUtc)} –{' '}
                          {shift.endUtc ? formatMadridTime(shift.endUtc) : 'En curso'}
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          {activeDayEvents.length > 0 && !hasUnsynced && !pendingVoidDay && (
                            <button
                              type="button"
                              onClick={() => onRequestVoidDay(shift.madridDateKey)}
                              className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50"
                            >
                              <Trash2 className="h-3 w-3" aria-hidden="true" />
                              Anular jornada completa
                            </button>
                          )}
                          {pendingVoidDay && (
                            <span className="text-[11px] font-semibold text-amber-700">
                              Anulación de jornada pendiente
                            </span>
                          )}
                          <div className="text-sm font-bold text-blue-700 font-mono tabular-nums">
                            {formatDurationShort(shift.effectiveMs)}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                        <span>{formatMadridDateLabel(shift.startUtc)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{shift.breaks.length} pausa(s)</span>
                        {ws && ws.plannedMinutes > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              Planificado: {formatMinutesShort(ws.plannedMinutes)} (dif.{' '}
                              {ws.deltaMinutes >= 0 ? `+${ws.deltaMinutes}` : ws.deltaMinutes} min)
                            </span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span className={statusInfo.colorClass}>{statusInfo.label}</span>
                        {ws?.hasPendingCorrection && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-amber-700">Corrección pendiente</span>
                          </>
                        )}
                        {ws?.hasApprovedCorrection && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-emerald-700">Corregido</span>
                          </>
                        )}
                        {ws?.isProvisionalCap && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold text-amber-800">
                              Provisional, pendiente de revisión
                            </span>
                          </>
                        )}
                      </div>

                      {ws && ws.anomalyFlags.length > 0 && (
                        <p className="text-xs font-medium text-amber-800">
                          Incidencia detectada:{' '}
                          {ws.anomalyFlags.map((f) => ANOMALY_LABELS[f]).join(' · ')}
                        </p>
                      )}

                      {/* Desglose individual de fichajes (originales nunca ocultos) */}
                      <div className="rounded-xl border border-slate-100 bg-slate-50/70 divide-y divide-slate-100">
                        {dayEvents.map((ev) => {
                          const isVoided = voidedEventIds.has(ev.id);
                          const isCompensatoryVoid = ev.type === 'event_void';
                          const pendingCorr = corrections.find(
                            (c) => c.targetEventId === ev.id && c.status === 'pending',
                          );
                          const approvedCorr = corrections.find(
                            (c) =>
                              (c.targetEventId === ev.id || c.id === ev.correctionId) &&
                              c.status === 'approved',
                          );

                          return (
                            <div
                              key={ev.id}
                              className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-xs"
                            >
                              <div className="space-y-0.5">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Clock className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                                  <span
                                    className={`font-medium ${
                                      isVoided ? 'line-through text-slate-400' : 'text-slate-800'
                                    }`}
                                  >
                                    {EVENT_LABELS[ev.type]}
                                  </span>
                                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                                    {formatMadridTime(ev.deviceDeclaredAt)}
                                  </span>
                                  {ev.source === 'admin' && (
                                    <span className="text-slate-600">
                                      · Declarada por empleado · Aprobada por administrador
                                    </span>
                                  )}
                                  {isVoided && (
                                    <span className="font-semibold text-slate-500">
                                      · Original anulado
                                    </span>
                                  )}
                                  {pendingCorr && (
                                    <span className="font-semibold text-amber-700">
                                      · Corrección pendiente
                                    </span>
                                  )}
                                  {!isVoided && approvedCorr && !isCompensatoryVoid && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setExpandedCorrId(
                                          expandedCorrId === approvedCorr.id ? null : approvedCorr.id,
                                        )
                                      }
                                      className="font-semibold text-emerald-700 underline underline-offset-2"
                                    >
                                      Corregido (ver detalle)
                                    </button>
                                  )}
                                </div>

                                {approvedCorr && expandedCorrId === approvedCorr.id && (
                                  <p className="pl-5 text-[11px] text-slate-600">
                                    Aprobado por {approvedCorr.resolvedByName ?? approvedCorr.resolvedByEmail} el{' '}
                                    {approvedCorr.resolvedAt
                                      ? `${getMadridDateKey(approvedCorr.resolvedAt)} ${formatMadridTime(approvedCorr.resolvedAt)}`
                                      : ''}
                                    {' · '}Motivo: {approvedCorr.reason}
                                  </p>
                                )}
                              </div>

                              {!isVoided && !isCompensatoryVoid && ev.syncStatus !== 'pendiente' && (
                                <button
                                  type="button"
                                  onClick={() => onRequestCorrectionForEvent(ev)}
                                  className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                                >
                                  <Edit3 className="h-3 w-3" aria-hidden="true" />
                                  Solicitar corrección
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* Listado de solicitudes de corrección del empleado */}
      <section className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-xs">
        <header className="border-b border-slate-100 bg-slate-50/70 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-slate-900">
            Mis solicitudes de corrección ({corrections.length})
          </h2>
        </header>

        {corrections.length === 0 ? (
          <p className="px-5 py-6 text-xs text-slate-500">
            No has enviado ninguna solicitud de corrección todavía.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {corrections.map((c) => {
              const st = CORRECTION_STATUS_LABELS[c.status];
              return (
                <li key={c.id} className="px-5 py-4 space-y-1.5 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold text-slate-900">
                      {c.kind === 'void_event'
                        ? 'Anular fichaje'
                        : c.kind === 'void_day'
                          ? 'Anular jornada completa'
                          : c.kind === 'change_time'
                            ? 'Cambiar hora'
                            : 'Añadir fichaje olvidado'}
                      {' · '}
                      <span className="font-mono tabular-nums">{c.preview.madridDateKey}</span>
                    </div>
                    <span className={st.cls}>{st.label}</span>
                  </div>

                  <p className="text-slate-600">{c.reason}</p>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-slate-500">
                    <span className="font-mono tabular-nums">
                      Jornada: {formatMinutesShort(c.preview.beforeWorkedMinutes)} →{' '}
                      {formatMinutesShort(c.preview.afterWorkedMinutes)}
                      {c.kind === 'void_day' && c.proposedChange.voidedEventSummaries?.length
                        ? ` · ${c.proposedChange.voidedEventSummaries.length} registro(s) incluidos`
                        : ''}
                      {c.proposedChange.declaredAtUtc
                        ? ` · Hora propuesta (declarada): ${formatMadridTime(c.proposedChange.declaredAtUtc)}`
                        : ''}
                    </span>

                    {c.status === 'pending' && (
                      <button
                        type="button"
                        disabled={cancellingId === c.id}
                        onClick={() => handleCancel(c.id)}
                        className="inline-flex min-h-[34px] items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                        {cancellingId === c.id ? 'Cancelando...' : 'Cancelar solicitud'}
                      </button>
                    )}
                  </div>

                  {c.status === 'rejected' && c.resolutionNote && (
                    <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">
                      Nota del administrador: {c.resolutionNote}
                    </p>
                  )}
                  {c.status === 'approved' && c.resolvedAt && (
                    <p className="text-emerald-700">
                      Aprobada por {c.resolvedByName ?? c.resolvedByEmail} ·{' '}
                      {getMadridDateKey(c.resolvedAt)} {formatMadridTime(c.resolvedAt)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
};

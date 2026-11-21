import React, { useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, Coffee, Play, RefreshCw, Square, Timer } from 'lucide-react';
import {
  formatDurationHms,
  formatDurationShort,
  formatMadridTime,
  formatMinutesShort,
  getMadridDateKey,
} from '../../shared/timeEngine';
import { ANOMALY_LABELS } from '../../shared/correctionsEngine';
import type {
  BreakType,
  ClockEventType,
  PlannedShift,
  WorkSession,
  WorkStateSnapshot,
} from '../../shared/types';
import { FinishShiftModal } from './FinishShiftModal';

interface ClockDashboardProps {
  employeeName: string;
  externalRef: string | null;
  snapshot: WorkStateSnapshot;
  breakTypes: BreakType[];
  plannedShifts: PlannedShift[];
  todayPlannedShift?: PlannedShift | null;
  activeSession?: WorkSession | null;
  showOverrunPrompt?: boolean;
  overrunMinutes?: number;
  anomalySessions: WorkSession[];
  queuedCount: number;
  isOnline: boolean;
  syncing: boolean;
  actionBusy: boolean;
  errorMessage: string | null;
  onClockAction: (
    type: Exclude<ClockEventType, 'event_void'>,
    options?: {
      breakTypeId?: string | null;
      assignmentRef?: string | null;
      facilityRef?: string | null;
      projectRef?: string | null;
    },
  ) => Promise<void>;
  onConfirmFinishShift: () => Promise<void>;
  onSyncNow: () => Promise<void>;
  onReviewAnomaly: (session: WorkSession) => void;
  onAcknowledgeOverrun?: (sessionId: string, reason: string) => Promise<void>;
}

const FACILITY_PRESETS = [
  { label: 'Centro completo', facilityRef: 'CENTRO-01', projectRef: 'OP-DIARIA' },
  { label: 'Pistas de Pádel', facilityRef: 'PADEL-EXT', projectRef: 'ESCUELA-PADEL' },
  { label: 'Sala Fitness', facilityRef: 'FITNESS-01', projectRef: 'ENTRENAMIENTO' },
  { label: 'Piscina Cubierta', facilityRef: 'PISCINA-25M', projectRef: 'CURSOS-AGUA' },
  { label: 'Recepción Principal', facilityRef: 'RECEP-01', projectRef: 'ATENCION-SOCIOS' },
];

const OVERRUN_REASONS = [
  'Turno ampliado autorizado',
  'Tarea pendiente',
  'Otro',
] as const;

export const ClockDashboard: React.FC<ClockDashboardProps> = ({
  employeeName,
  externalRef,
  snapshot,
  breakTypes,
  plannedShifts,
  todayPlannedShift,
  activeSession,
  showOverrunPrompt = false,
  overrunMinutes = 0,
  anomalySessions,
  queuedCount,
  isOnline,
  syncing,
  actionBusy,
  errorMessage,
  onClockAction,
  onConfirmFinishShift,
  onSyncNow,
  onReviewAnomaly,
  onAcknowledgeOverrun,
}) => {
  const [selectedBreakTypeId, setSelectedBreakTypeId] = useState<string>('');
  const [selectedFacilityIdx, setSelectedFacilityIdx] = useState<number>(0);
  const [assignmentRef, setAssignmentRef] = useState<string>('');
  const [showFinishModal, setShowFinishModal] = useState(false);

  const [showContinueForm, setShowContinueForm] = useState(false);
  const [selectedReasonOption, setSelectedReasonOption] = useState<string>(OVERRUN_REASONS[0]);
  const [customReasonText, setCustomReasonText] = useState('');
  const [overrunBusy, setOverrunBusy] = useState(false);
  const [overrunError, setOverrunError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedBreakTypeId && breakTypes.length > 0) {
      setSelectedBreakTypeId(breakTypes[0].id);
    }
  }, [breakTypes, selectedBreakTypeId]);

  const todayKey = getMadridDateKey(new Date().toISOString());
  const todayPlanned =
    todayPlannedShift ?? plannedShifts.find((s) => s.madridDateKey === todayKey) ?? null;
  const primaryAnomaly = anomalySessions.find((s) => s.id !== activeSession?.id) ?? null;

  const effectiveMinutesLive = activeSession?.isProvisionalCap
    ? activeSession.workedMinutes
    : Math.round(snapshot.effectiveMs / 60_000);
  const plannedProgressPct =
    todayPlanned && todayPlanned.plannedMinutes > 0
      ? Math.min(100, Math.round((effectiveMinutesLive / todayPlanned.plannedMinutes) * 100))
      : 0;
  const plannedEndTimeLabel = activeSession?.plannedEndUtc
    ? formatMadridTime(activeSession.plannedEndUtc)
    : todayPlanned
      ? formatMadridTime(todayPlanned.endUtc)
      : '';

  const stateMeta = {
    fuera: {
      label: 'Fuera de jornada',
      accentText: 'text-slate-700',
      borderClass: 'border-slate-200 bg-white',
      helper: 'Pulsa Iniciar jornada cuando comiences tu turno.',
    },
    en_jornada: {
      label: 'En jornada activa',
      accentText: 'text-emerald-700',
      borderClass: 'border-emerald-200 bg-white',
      helper: 'El contador de tiempo efectivo está en marcha.',
    },
    en_pausa: {
      label: 'En pausa',
      accentText: 'text-amber-700',
      borderClass: 'border-amber-200 bg-white',
      helper: 'Tiempo efectivo detenido hasta que reanudes la jornada.',
    },
  }[snapshot.workState];

  const handleStartShift = async () => {
    const preset = FACILITY_PRESETS[selectedFacilityIdx] ?? FACILITY_PRESETS[0];
    await onClockAction('shift_start', {
      facilityRef: preset.facilityRef,
      projectRef: preset.projectRef,
      assignmentRef: assignmentRef.trim() || null,
    });
  };

  const handleStartBreak = async () => {
    await onClockAction('break_start', {
      breakTypeId: selectedBreakTypeId || null,
      facilityRef: snapshot.activeFacilityRef,
      projectRef: snapshot.activeProjectRef,
      assignmentRef: snapshot.activeAssignmentRef,
    });
  };

  const handleResume = async () => {
    await onClockAction('break_end', {
      facilityRef: snapshot.activeFacilityRef,
      projectRef: snapshot.activeProjectRef,
      assignmentRef: snapshot.activeAssignmentRef,
    });
  };

  const handleConfirmFinish = async () => {
    await onConfirmFinishShift();
    setShowFinishModal(false);
    setShowContinueForm(false);
  };

  const handleSubmitContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeSession || !onAcknowledgeOverrun) return;
    const finalReason =
      selectedReasonOption === 'Otro' ? customReasonText.trim() : selectedReasonOption;
    if (finalReason.length < 2) {
      setOverrunError('Indica el motivo por el que continúas trabajando.');
      return;
    }
    setOverrunBusy(true);
    setOverrunError(null);
    try {
      await onAcknowledgeOverrun(activeSession.id, finalReason);
      setShowContinueForm(false);
      setCustomReasonText('');
    } catch (err) {
      setOverrunError(err instanceof Error ? err.message : 'No se pudo registrar el motivo.');
    } finally {
      setOverrunBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {errorMessage && (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          {errorMessage}
        </div>
      )}

      {showOverrunPrompt && activeSession && (
        <div
          role="alert"
          className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-5 text-sm text-amber-950 shadow-xs space-y-4"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
            <div className="space-y-1">
              <p className="font-bold text-base">
                Tu jornada prevista terminó a las {plannedEndTimeLabel}. ¿Sigues trabajando?
              </p>
              <p className="text-xs text-amber-900">
                Llevas {overrunMinutes} min desde la hora prevista de fin. Si olvidaste fichar la
                salida, finaliza tu jornada; si continúas trabajando, indícanos el motivo.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setShowFinishModal(true)}
              className="min-h-[44px] rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700"
            >
              Finalizar jornada
            </button>
            <button
              type="button"
              onClick={() => setShowContinueForm((prev) => !prev)}
              className="min-h-[44px] rounded-xl border border-amber-400 bg-white px-4 py-2 text-xs font-semibold text-amber-950 hover:bg-amber-100"
            >
              Sigo trabajando
            </button>
          </div>

          {showContinueForm && (
            <form onSubmit={handleSubmitContinue} className="rounded-xl border border-amber-200 bg-white p-4 space-y-3">
              <p className="text-xs font-semibold text-slate-800">
                Motivo para continuar trabajando:
              </p>
              <div className="flex flex-wrap gap-2">
                {OVERRUN_REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setSelectedReasonOption(r)}
                    className={`min-h-[38px] rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                      selectedReasonOption === r
                        ? 'border-blue-600 bg-blue-50 text-blue-700'
                        : 'border-slate-200 text-slate-700'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              {selectedReasonOption === 'Otro' && (
                <input
                  type="text"
                  required
                  value={customReasonText}
                  onChange={(e) => setCustomReasonText(e.target.value)}
                  placeholder="Describe brevemente el motivo..."
                  className="min-h-[40px] w-full rounded-xl border border-slate-300 px-3 text-xs"
                />
              )}
              {overrunError && <p className="text-xs text-rose-700">{overrunError}</p>}
              <button
                type="submit"
                disabled={overrunBusy}
                className="min-h-[40px] rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {overrunBusy ? 'Guardando...' : 'Confirmar continuidad'}
              </button>
            </form>
          )}
        </div>
      )}

      {primaryAnomaly && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3.5 text-sm text-amber-950"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
            <div>
              <p className="font-semibold">
                Revisa tu fichaje de ayer ({primaryAnomaly.madridDate})
              </p>
              <p className="mt-0.5 text-xs text-amber-900">
                {primaryAnomaly.anomalyFlags.map((f) => ANOMALY_LABELS[f]).join(' · ')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onReviewAnomaly(primaryAnomaly)}
            className="min-h-[40px] rounded-xl bg-amber-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-amber-700 whitespace-nowrap"
          >
            Solicitar corrección
          </button>
        </div>
      )}

      {(!isOnline || queuedCount > 0) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <div>
            <p className="font-semibold">
              {!isOnline
                ? 'Modo sin conexión activo'
                : `${queuedCount} fichaje(s) pendientes de envío`}
            </p>
            <p className="text-xs text-amber-800">
              {!isOnline
                ? 'Tus fichajes se guardan en el dispositivo y se enviarán automáticamente al volver la señal.'
                : 'Se enviarán al servidor con su hora declarada del dispositivo.'}
            </p>
          </div>
          {isOnline && queuedCount > 0 && (
            <button
              type="button"
              disabled={syncing}
              onClick={onSyncNow}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} aria-hidden="true" />
              {syncing ? 'Sincronizando...' : 'Sincronizar ahora'}
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section
          aria-label="Reloj de jornada"
          className={`lg:col-span-7 rounded-2xl border p-6 sm:p-8 shadow-xs ${stateMeta.borderClass}`}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className={`text-sm font-semibold ${stateMeta.accentText}`}>{stateMeta.label}</p>
              <h1 className="mt-1 text-2xl sm:text-3xl font-bold text-slate-900">
                {employeeName}
              </h1>
            </div>
            <p className="text-xs text-slate-500">
              {externalRef ? `Ref. MiTa: ${externalRef}` : 'Sin ref. externa'} · Hora Madrid
            </p>
          </div>

          {todayPlanned ? (
            <div className="mt-5 rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-slate-900 tabular-nums">
                  Tu jornada de hoy: {formatMadridTime(todayPlanned.startUtc)} a{' '}
                  {formatMadridTime(todayPlanned.endUtc)} (
                  {todayPlanned.plannedMinutes % 60 === 0
                    ? `${todayPlanned.plannedMinutes / 60} h`
                    : formatMinutesShort(todayPlanned.plannedMinutes)}
                  )
                </span>
                <span className="font-mono font-semibold text-blue-700 tabular-nums">
                  {effectiveMinutesLive} / {todayPlanned.plannedMinutes} min
                </span>
              </div>
              <div
                className="h-2.5 w-full overflow-hidden rounded-full bg-blue-100"
                role="progressbar"
                aria-valuenow={plannedProgressPct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`h-full transition-all duration-300 ${
                    activeSession?.status === 'flagged'
                      ? 'bg-amber-500'
                      : effectiveMinutesLive >= todayPlanned.plannedMinutes
                        ? 'bg-emerald-600'
                        : 'bg-blue-600'
                  }`}
                  style={{ width: `${plannedProgressPct}%` }}
                />
              </div>
              {activeSession?.overrunAcknowledged && activeSession.overrunReason && (
                <p className="text-[11px] font-medium text-emerald-800">
                  Continuidad confirmada: {activeSession.overrunReason}
                </p>
              )}
            </div>
          ) : (
            snapshot.workState !== 'fuera' && (
              <p className="mt-4 text-xs font-medium text-slate-500">
                Sin jornada planificada hoy (registrado como turno no planificado).
              </p>
            )
          )}

          <div className="mt-6 rounded-2xl border border-slate-100 bg-slate-50/80 px-5 py-7 text-center">
            <p className="text-xs font-medium text-slate-500">Tiempo efectivo de jornada</p>
            <p
              data-testid="effective-timer"
              className="mt-2 font-mono text-5xl sm:text-6xl font-bold tracking-tight text-slate-900 tabular-nums"
            >
              {formatDurationHms(
                activeSession?.isProvisionalCap
                  ? activeSession.workedMinutes * 60_000
                  : snapshot.effectiveMs,
              )}
            </p>
            {activeSession?.isProvisionalCap && (
              <p className="mt-2 text-xs font-semibold text-amber-800">
                Provisional, pendiente de revisión (tope aplicado hasta resolución)
              </p>
            )}
            <p className="mt-3 text-xs text-slate-600">{stateMeta.helper}</p>

            {snapshot.activeShiftStart && (
              <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t border-slate-200/80 pt-4 text-xs text-slate-600">
                <span className="tabular-nums">
                  Inicio: <strong className="text-slate-900">{formatMadridTime(snapshot.activeShiftStart)}</strong>
                </span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">
                  Pausas acumuladas:{' '}
                  <strong className="text-slate-900">{formatDurationShort(snapshot.breakMs)}</strong>
                </span>
                {snapshot.activeFacilityRef && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Instalación: {snapshot.activeFacilityRef}</span>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Controles ergonómicos en zona de pulgar */}
          <div className="mt-6 space-y-4">
            {snapshot.workState === 'fuera' && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="facility-select"
                      className="block text-xs font-medium text-slate-600"
                    >
                      Instalación (referencia MiTa opcional)
                    </label>
                    <select
                      id="facility-select"
                      value={selectedFacilityIdx}
                      onChange={(e) => setSelectedFacilityIdx(Number(e.target.value))}
                      className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-blue-600 focus:outline-none"
                    >
                      {FACILITY_PRESETS.map((preset, idx) => (
                        <option key={preset.facilityRef} value={idx}>
                          {preset.label} ({preset.facilityRef})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="assignment-input"
                      className="block text-xs font-medium text-slate-600"
                    >
                      Asignación / Turno (opcional)
                    </label>
                    <input
                      id="assignment-input"
                      type="text"
                      value={assignmentRef}
                      onChange={(e) => setAssignmentRef(e.target.value)}
                      placeholder="Ej. TURNO-MANANA"
                      className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={handleStartShift}
                  className="min-h-[56px] w-full inline-flex items-center justify-center gap-2.5 rounded-xl bg-blue-600 px-6 py-3.5 text-base font-semibold text-white shadow-xs transition hover:bg-blue-700 active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50"
                >
                  <Play className="h-5 w-5" aria-hidden="true" />
                  {actionBusy ? 'Registrando...' : 'Iniciar jornada'}
                </button>
              </>
            )}

            {snapshot.workState === 'en_jornada' && (
              <>
                {breakTypes.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-slate-600 mb-2">Motivo de pausa</p>
                    <div className="flex flex-wrap gap-2">
                      {breakTypes.map((bt) => {
                        const active = selectedBreakTypeId === bt.id;
                        return (
                          <button
                            key={bt.id}
                            type="button"
                            onClick={() => setSelectedBreakTypeId(bt.id)}
                            className={`min-h-[40px] rounded-xl border px-3 py-2 text-xs font-medium transition whitespace-nowrap ${
                              active
                                ? 'border-amber-500 bg-amber-50 text-amber-900'
                                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                            }`}
                          >
                            {bt.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={handleStartBreak}
                    className="min-h-[54px] inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-3 text-base font-semibold text-white transition hover:bg-amber-600 active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 disabled:opacity-50"
                  >
                    <Coffee className="h-5 w-5" aria-hidden="true" />
                    Pausa
                  </button>
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => setShowFinishModal(true)}
                    className="min-h-[54px] inline-flex items-center justify-center gap-2 rounded-xl border border-rose-300 bg-white px-5 py-3 text-base font-semibold text-rose-700 transition hover:bg-rose-50 active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 disabled:opacity-50"
                  >
                    <Square className="h-4 w-4" aria-hidden="true" />
                    Finalizar jornada
                  </button>
                </div>
              </>
            )}

            {snapshot.workState === 'en_pausa' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={handleResume}
                  className="min-h-[54px] inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-base font-semibold text-white transition hover:bg-emerald-700 active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:opacity-50"
                >
                  <Play className="h-5 w-5" aria-hidden="true" />
                  Reanudar
                </button>
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() => setShowFinishModal(true)}
                  className="min-h-[54px] inline-flex items-center justify-center gap-2 rounded-xl border border-rose-300 bg-white px-5 py-3 text-base font-semibold text-rose-700 transition hover:bg-rose-50 active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 disabled:opacity-50"
                >
                  <Square className="h-4 w-4" aria-hidden="true" />
                  Finalizar jornada
                </button>
              </div>
            )}
          </div>
        </section>

        <aside className="lg:col-span-5 space-y-5">
          {todayPlanned && (
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-2">
              <div className="flex items-center gap-2 text-slate-900">
                <CalendarClock className="h-4 w-4 text-blue-600" aria-hidden="true" />
                <h2 className="text-sm font-semibold">Turno planificado hoy</h2>
              </div>
              <p className="font-mono text-base font-bold text-slate-900 tabular-nums">
                {formatMadridTime(todayPlanned.startUtc)} – {formatMadridTime(todayPlanned.endUtc)}
              </p>
              <p className="text-xs text-slate-500">
                {formatMinutesShort(todayPlanned.plannedMinutes)} planificados ·{' '}
                {todayPlanned.facilityRef ?? 'Centro'}
              </p>
            </div>
          )}

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs space-y-5">
            <div className="flex items-center gap-2 text-slate-900">
              <Timer className="h-5 w-5 text-blue-600" aria-hidden="true" />
              <h2 className="text-lg font-semibold">Pausas de la jornada actual</h2>
            </div>

            {snapshot.workState === 'fuera' ? (
              <p className="text-sm text-slate-500">
                No hay ninguna jornada abierta en este momento. Al iniciar jornada verás aquí el
                desglose de descansos y el contexto asignado en MiTa.
              </p>
            ) : (
              <div className="space-y-3">
                {snapshot.openBreak && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-amber-950">
                        {snapshot.openBreak.breakTypeName} (en curso)
                      </span>
                      <span className="font-mono font-semibold text-amber-800 tabular-nums">
                        {formatDurationHms(snapshot.openBreak.durationMs)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-amber-800 tabular-nums">
                      Desde las {formatMadridTime(snapshot.openBreak.startUtc)}
                    </p>
                  </div>
                )}

                {snapshot.breaksCompleted.length === 0 && !snapshot.openBreak ? (
                  <p className="text-sm text-slate-500">Aún no se han registrado pausas en este turno.</p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {snapshot.breaksCompleted.map((b) => (
                      <li key={b.id} className="flex items-center justify-between py-2.5 text-sm">
                        <div>
                          <p className="font-medium text-slate-800">{b.breakTypeName}</p>
                          <p className="text-xs text-slate-500 font-mono tabular-nums">
                            {formatMadridTime(b.startUtc)} – {b.endUtc ? formatMadridTime(b.endUtc) : ''}
                          </p>
                        </div>
                        <span className="font-mono text-xs font-semibold text-slate-700 tabular-nums">
                          {formatDurationShort(b.durationMs)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      <FinishShiftModal
        open={showFinishModal}
        shiftStartUtc={snapshot.activeShiftStart}
        effectiveMs={snapshot.effectiveMs}
        breakMs={snapshot.breakMs}
        breaks={[
          ...snapshot.breaksCompleted,
          ...(snapshot.openBreak ? [snapshot.openBreak] : []),
        ]}
        isOnBreak={snapshot.workState === 'en_pausa'}
        submitting={actionBusy}
        onCancel={() => setShowFinishModal(false)}
        onConfirm={handleConfirmFinish}
      />
    </div>
  );
};

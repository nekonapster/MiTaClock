import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  Bell,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Coffee,
  FileText,
  Plus,
  RefreshCw,
  Trash2,
  Users,
  XCircle,
} from 'lucide-react';
import { api, ApiError } from '../api';
import {
  addDaysToDateKey,
  formatDurationShort,
  formatMadridTime,
  formatMinutesShort,
  getMadridDateKey,
  getMondayOfWeek,
} from '../../shared/timeEngine';
import { ANOMALY_LABELS } from '../../shared/correctionsEngine';
import type {
  AdminEmployeeOverview,
  AdminOpenSessionView,
  AuditLogEntry,
  BreakType,
  ClockEvent,
  CorrectionKind,
  CorrectionRequest,
  CorrectionStatus,
  DailySummaryRow,
  Employee,
  MitaExportEvent,
  MitaOutboxItem,
  ProposedCorrectionChange,
  UserRole,
  WorkSession,
} from '../../shared/types';
import { CorrectionModal } from './CorrectionModal';
import { AdminPlanningSection } from './AdminPlanningSection';

type AdminTab =
  | 'live'
  | 'planning'
  | 'open_sessions'
  | 'daily_summary'
  | 'corrections'
  | 'sessions'
  | 'employees'
  | 'breaks'
  | 'audit_outbox'
  | 'mita';

const STATE_LABEL: Record<AdminEmployeeOverview['workState'], { text: string; cls: string }> = {
  fuera: { text: 'Fuera de jornada', cls: 'text-slate-600' },
  en_jornada: { text: 'En jornada', cls: 'text-emerald-700 font-semibold' },
  en_pausa: { text: 'En pausa', cls: 'text-amber-700 font-semibold' },
};

interface AdminPanelProps {
  currentUserId: string;
}

export const AdminPanel: React.FC<AdminPanelProps> = ({ currentUserId }) => {
  const [tab, setTab] = useState<AdminTab>('live');
  const [overview, setOverview] = useState<AdminEmployeeOverview[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [breakTypes, setBreakTypes] = useState<BreakType[]>([]);
  const [mitaEvents, setMitaEvents] = useState<MitaExportEvent[]>([]);
  const [mitaFilter, setMitaFilter] = useState<'all' | 'enviado' | 'confirmado'>('all');

  // Correcciones, sesiones, auditoría y outbox
  const [corrections, setCorrections] = useState<CorrectionRequest[]>([]);
  const [corrStatusFilter, setCorrStatusFilter] = useState<'' | CorrectionStatus>('pending');
  const [corrEmployeeFilter, setCorrEmployeeFilter] = useState<string>('');
  const [corrKindFilter, setCorrKindFilter] = useState<'' | CorrectionKind>('');
  const [corrFromFilter, setCorrFromFilter] = useState<string>('');
  const [corrToFilter, setCorrToFilter] = useState<string>('');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState<string>('');

  const [workSessions, setWorkSessions] = useState<WorkSession[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditLogEntry[]>([]);
  const [outboxItems, setOutboxItems] = useState<MitaOutboxItem[]>([]);

  // Vigilancia de relojes olvidados y resumen diario
  const [openSessions, setOpenSessions] = useState<AdminOpenSessionView[]>([]);
  const [openIncidentCount, setOpenIncidentCount] = useState<number>(0);
  const todayKey = getMadridDateKey(new Date().toISOString());
  const [summaryFrom, setSummaryFrom] = useState<string>(() => getMondayOfWeek(todayKey));
  const [summaryTo, setSummaryTo] = useState<string>(() => addDaysToDateKey(getMondayOfWeek(todayKey), 6));
  const [summaryEmployeeId, setSummaryEmployeeId] = useState<string>('');
  const [dailyRows, setDailyRows] = useState<DailySummaryRow[]>([]);

  // Crear corrección directa desde admin para un empleado
  const [showAdminCorrModal, setShowAdminCorrModal] = useState(false);
  const [adminCorrEmployeeId, setAdminCorrEmployeeId] = useState('');
  const [adminCorrInitialKind, setAdminCorrInitialKind] = useState<CorrectionKind>('add_event');
  const [adminCorrInitialDate, setAdminCorrInitialDate] = useState<string | undefined>(undefined);
  const [adminCorrEvents, setAdminCorrEvents] = useState<ClockEvent[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Formulario nuevo empleado
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('employee');
  const [newExternalRef, setNewExternalRef] = useState('');

  // Formulario nuevo tipo de pausa
  const [breakCode, setBreakCode] = useState('');
  const [breakName, setBreakName] = useState('');
  const [breakPaid, setBreakPaid] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, emp, bt, mita, corrs, sess, aud, outbox, openRes, summaryRes] = await Promise.all([
        api.getAdminOverview(),
        api.getAdminEmployees(),
        api.getBreakTypes(),
        api.getMitaEvents(mitaFilter === 'all' ? undefined : mitaFilter),
        api.getCorrections({
          employeeId: corrEmployeeFilter || undefined,
          status: corrStatusFilter || undefined,
          kind: corrKindFilter || undefined,
          from: corrFromFilter || undefined,
          to: corrToFilter || undefined,
        }),
        api.getWorkSessions(),
        api.getAuditLog(100),
        api.getOutboxItems(),
        api.getAdminOpenSessions().catch(() => ({ openSessions: [], openIncidentCount: 0 })),
        api
          .getDailySummary({
            from: summaryFrom,
            to: summaryTo,
            employeeId: summaryEmployeeId || undefined,
          })
          .catch(() => ({ rows: [], from: summaryFrom, to: summaryTo })),
      ]);
      setOverview(ov.employees);
      setEmployees(emp.employees);
      if (!adminCorrEmployeeId && emp.employees.length > 0) {
        setAdminCorrEmployeeId(emp.employees[0].id);
      }
      setBreakTypes(bt.breakTypes);
      setMitaEvents(mita.events);
      setCorrections(corrs.corrections);
      setWorkSessions(sess.sessions);
      setAuditEntries(aud.entries);
      setOutboxItems(outbox.items);
      setOpenSessions(openRes.openSessions);
      setOpenIncidentCount(openRes.openIncidentCount);
      setDailyRows(summaryRes.rows);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al cargar datos de administración.');
    } finally {
      setLoading(false);
    }
  }, [
    mitaFilter,
    corrEmployeeFilter,
    corrStatusFilter,
    corrKindFilter,
    corrFromFilter,
    corrToFilter,
    adminCorrEmployeeId,
    summaryFrom,
    summaryTo,
    summaryEmployeeId,
  ]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!showAdminCorrModal || !adminCorrEmployeeId) return;
    api
      .getClockEvents(adminCorrEmployeeId)
      .then((res) => setAdminCorrEvents(res.events))
      .catch(() => setAdminCorrEvents([]));
  }, [showAdminCorrModal, adminCorrEmployeeId]);

  const handleRunWatchdogNow = async () => {
    setError(null);
    setNotice(null);
    try {
      const res = await api.runWatchdog();
      setNotice(
        `Vigilancia ejecutada: ${res.summary.checkedEmployees} empleados revisados, ${res.summary.flaggedCount} flagged, ${res.summary.incompleteCount} incompletas.`,
      );
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al ejecutar la vigilancia.');
    }
  };

  const handleAcknowledgeIncident = async (incidentId: string) => {
    setError(null);
    try {
      await api.acknowledgeIncident(incidentId);
      setNotice('Incidencia marcada como revisada.');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo acusar recibo.');
    }
  };

  const handleResolveOpenSession = (item: AdminOpenSessionView) => {
    setAdminCorrEmployeeId(item.session.employeeId);
    setAdminCorrInitialKind('add_event');
    setAdminCorrInitialDate(item.session.madridDate);
    setShowAdminCorrModal(true);
  };

  const handleOpenAdminVoidDay = (employeeId?: string, madridDate?: string) => {
    if (employeeId) {
      setAdminCorrEmployeeId(employeeId);
    }
    setAdminCorrInitialKind('void_day');
    setAdminCorrInitialDate(madridDate);
    setShowAdminCorrModal(true);
  };

  const handleApproveCorrection = async (c: CorrectionRequest) => {
    setError(null);
    setNotice(null);
    try {
      await api.approveCorrection(c.id, undefined, crypto.randomUUID());
      setNotice('Corrección aprobada, sesión recalculada y encolada en el outbox de MiTa.');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo aprobar la corrección.');
    }
  };

  const handleConfirmReject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectingId) return;
    setError(null);
    setNotice(null);
    try {
      await api.rejectCorrection(rejectingId, rejectNote);
      setRejectingId(null);
      setRejectNote('');
      setNotice('Solicitud rechazada con nota registrada.');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo rechazar la solicitud.');
    }
  };

  const handleCreateAdminCorrection = async (payload: {
    employeeId: string;
    targetEventId: string | null;
    kind: CorrectionKind;
    reason: string;
    proposedChange?: ProposedCorrectionChange;
  }) => {
    await api.createCorrection(payload, crypto.randomUUID());
    setNotice('Corrección creada por administrador (pendiente de aprobación por otro administrador).');
    await loadAll();
  };

  const handleProcessOutbox = async () => {
    setError(null);
    setNotice(null);
    try {
      const res = await api.processOutbox();
      setNotice(`Outbox procesado: ${res.sentCount} enviado(s), ${res.failedCount} con error.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al procesar el outbox.');
    }
  };

  const handleCreateEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await api.createEmployee({
        name: newName,
        email: newEmail,
        password: newPassword,
        role: newRole,
        externalRef: newExternalRef.trim() || null,
      });
      setNewName('');
      setNewEmail('');
      setNewPassword('');
      setNewExternalRef('');
      setNotice('Usuario creado correctamente.');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear el usuario.');
    }
  };

  const handleToggleEmployeeStatus = async (emp: Employee) => {
    setError(null);
    const nextStatus = emp.status === 'active' ? 'inactive' : 'active';
    try {
      await api.updateEmployee(emp.id, {
        status: nextStatus,
        isUserActive: nextStatus === 'active',
      });
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo actualizar el empleado.');
    }
  };

  const handleCreateBreakType = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await api.createBreakType({
        code: breakCode,
        name: breakName,
        isPaid: breakPaid,
      });
      setBreakCode('');
      setBreakName('');
      setBreakPaid(false);
      setNotice('Tipo de pausa creado.');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear el tipo de pausa.');
    }
  };

  const handleToggleBreakActive = async (bt: BreakType) => {
    setError(null);
    try {
      await api.updateBreakType(bt.id, { isActive: !bt.isActive });
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al actualizar el tipo de pausa.');
    }
  };

  const handleConfirmPendingMita = async () => {
    setError(null);
    setNotice(null);
    const pendingIds = mitaEvents
      .filter((e) => e.sync_status === 'enviado')
      .map((e) => e.event_id);

    if (pendingIds.length === 0) {
      setNotice('No hay fichajes en estado enviado pendientes de confirmación.');
      return;
    }

    try {
      const res = await api.confirmMitaEvents(pendingIds, `MITA-SYNC-${Date.now()}`);
      setNotice(`${res.confirmedCount} fichaje(s) confirmados con referencia ${res.mita_ack_ref}.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al confirmar con MiTa v2.0.');
    }
  };

  const employeeNameMap = new Map(employees.map((e) => [e.id, e.name]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Panel de administración</h1>
          <p className="mt-1 text-xs text-slate-500">
            Supervisión, bandeja de correcciones, detección de anomalías y sincronización MiTa v2.0.
          </p>
        </div>

        <button
          type="button"
          onClick={loadAll}
          disabled={loading}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          Actualizar
        </button>
      </div>

      {openIncidentCount > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-3.5 text-sm text-rose-950"
        >
          <div className="flex items-center gap-2.5">
            <Bell className="h-5 w-5 text-rose-600 shrink-0" aria-hidden="true" />
            <p className="font-semibold">
              {openIncidentCount} incidencia(s) abierta(s) por relojes sin cerrar fuera de horario.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setTab('open_sessions')}
            className="min-h-[38px] rounded-xl bg-rose-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
          >
            Ver jornadas abiertas
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-1 rounded-xl bg-slate-200/70 p-1">
        {(
          [
            { id: 'live', label: 'Equipo en vivo', icon: Users },
            { id: 'planning', label: 'Jornadas planificadas', icon: CalendarClock },
            {
              id: 'open_sessions',
              label:
                openSessions.length > 0
                  ? `Jornadas abiertas (${openSessions.length})`
                  : 'Jornadas abiertas',
              icon: Clock,
            },
            { id: 'daily_summary', label: 'Resumen diario', icon: BarChart3 },
            { id: 'corrections', label: 'Correcciones', icon: ClipboardCheck },
            { id: 'sessions', label: 'Sesiones y anomalías', icon: AlertTriangle },
            { id: 'employees', label: 'Empleados', icon: Plus },
            { id: 'breaks', label: 'Pausas', icon: Coffee },
            { id: 'audit_outbox', label: 'Auditoría y Outbox', icon: FileText },
            { id: 'mita', label: 'MiTa v2.0', icon: ArrowUpRight },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`min-h-[40px] inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition whitespace-nowrap ${
                active ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {notice}
        </div>
      )}

      {tab === 'planning' && (
        <AdminPlanningSection employees={employees} onChanged={loadAll} />
      )}

      {tab === 'open_sessions' && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Jornadas abiertas fuera de horario
              </h2>
              <p className="text-xs text-slate-500">
                El servidor vigila automáticamente cada 5 minutos. Nunca se crea un fin de jornada
                inventado; resuelve cada caso creando una corrección de salida real.
              </p>
            </div>
            <button
              type="button"
              onClick={handleRunWatchdogNow}
              className="min-h-[40px] rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Ejecutar vigilancia ahora
            </button>
          </div>

          {openSessions.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              No hay jornadas abiertas fuera de horario ni incidencias pendientes.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-xs">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Empleado</th>
                    <th className="px-4 py-3 font-semibold">Inicio / Fecha</th>
                    <th className="px-4 py-3 font-semibold">Fin previsto</th>
                    <th className="px-4 py-3 font-semibold">Exceso</th>
                    <th className="px-4 py-3 font-semibold">Estado</th>
                    <th className="px-4 py-3 font-semibold">Trabajado</th>
                    <th className="px-4 py-3 font-semibold">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {openSessions.map((item) => (
                    <tr key={item.session.id}>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-900">{item.employeeName}</p>
                        <p className="text-slate-500">{item.employeeEmail}</p>
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums">
                        {item.session.madridDate} · {formatMadridTime(item.session.startUtc)}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums">
                        {item.plannedEndUtc ? formatMadridTime(item.plannedEndUtc) : 'Sin turno'}
                      </td>
                      <td className="px-4 py-3 font-mono font-semibold text-amber-800 tabular-nums">
                        +{item.overrunMinutes} min
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-semibold text-rose-700">{item.session.status}</span>
                        {item.session.overrunAcknowledged && (
                          <span className="block text-[11px] text-emerald-700">
                            Confirmado: {item.session.overrunReason}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums">
                        {item.session.workedMinutes} min
                        {item.session.isProvisionalCap && (
                          <span className="block text-[11px] text-amber-700">
                            Provisional, pendiente de revisión
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleResolveOpenSession(item)}
                            className="min-h-[36px] rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-blue-700"
                          >
                            Resolver con corrección
                          </button>
                          {item.incident && item.incident.status === 'open' && (
                            <button
                              type="button"
                              onClick={() => handleAcknowledgeIncident(item.incident!.id)}
                              className="min-h-[36px] rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              Acusar recibo
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'daily_summary' && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 flex-1">
              <div>
                <label className="block text-[11px] font-medium text-slate-600">Desde</label>
                <input
                  type="date"
                  value={summaryFrom}
                  onChange={(e) => setSummaryFrom(e.target.value)}
                  className="mt-1 min-h-[38px] w-full rounded-lg border border-slate-300 px-2.5 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600">Hasta</label>
                <input
                  type="date"
                  value={summaryTo}
                  onChange={(e) => setSummaryTo(e.target.value)}
                  className="mt-1 min-h-[38px] w-full rounded-lg border border-slate-300 px-2.5 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600">Empleado</label>
                <select
                  value={summaryEmployeeId}
                  onChange={(e) => setSummaryEmployeeId(e.target.value)}
                  className="mt-1 min-h-[38px] w-full rounded-lg border border-slate-300 bg-white px-2.5 text-xs"
                >
                  <option value="">Todos los empleados</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-xs">
            {dailyRows.length === 0 ? (
              <p className="p-8 text-center text-sm text-slate-500">
                No hay registros planificados ni trabajados en este rango de fechas.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Fecha</th>
                    <th className="px-4 py-3 font-semibold">Empleado</th>
                    <th className="px-4 py-3 font-semibold">Planificado</th>
                    <th className="px-4 py-3 font-semibold">Trabajado</th>
                    <th className="px-4 py-3 font-semibold">Desviación (delta)</th>
                    <th className="px-4 py-3 font-semibold">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {dailyRows.map((row) => {
                    const deltaCls =
                      row.status === 'ok' || row.status === 'day_off'
                        ? 'text-emerald-700'
                        : row.status === 'flagged' || row.status === 'incomplete' || row.status === 'absent'
                          ? 'text-rose-700'
                          : 'text-amber-700';
                    return (
                      <tr key={`${row.employeeId}-${row.madridDate}`}>
                        <td className="px-4 py-3 font-mono tabular-nums">{row.madridDate}</td>
                        <td className="px-4 py-3 font-semibold text-slate-900">
                          {row.employeeName}
                        </td>
                        <td className="px-4 py-3 font-mono tabular-nums">
                          {formatMinutesShort(row.plannedMinutes)} ({row.plannedMinutes} min)
                        </td>
                        <td className="px-4 py-3 font-mono tabular-nums">
                          {formatMinutesShort(row.workedMinutes)} ({row.workedMinutes} min)
                          {row.isProvisional && (
                            <span className="block text-[11px] text-amber-700">
                              Provisional, pendiente de revisión
                            </span>
                          )}
                        </td>
                        <td className={`px-4 py-3 font-mono font-bold tabular-nums ${deltaCls}`}>
                          {row.deltaMinutes >= 0 ? `+${row.deltaMinutes}` : row.deltaMinutes} min
                        </td>
                        <td className={`px-4 py-3 font-semibold ${deltaCls}`}>{row.status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {tab === 'live' && (
        <section className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="px-5 py-3.5 font-semibold">Empleado</th>
                  <th className="px-5 py-3.5 font-semibold">Estado</th>
                  <th className="px-5 py-3.5 font-semibold">Inicio turno</th>
                  <th className="px-5 py-3.5 font-semibold">Efectivo hoy</th>
                  <th className="px-5 py-3.5 font-semibold">Pendientes MiTa</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {overview.map((emp) => {
                  const st = STATE_LABEL[emp.workState];
                  return (
                    <tr key={emp.id} className="hover:bg-slate-50/60">
                      <td className="px-5 py-3.5">
                        <p className="font-semibold text-slate-900">{emp.name}</p>
                        <p className="text-xs text-slate-500">
                          {emp.email} · {emp.externalRef ?? 'Sin ref.'}
                        </p>
                      </td>
                      <td className={`px-5 py-3.5 text-xs ${st.cls}`}>{st.text}</td>
                      <td className="px-5 py-3.5 font-mono text-xs text-slate-700 tabular-nums">
                        {emp.activeShiftStart ? formatMadridTime(emp.activeShiftStart) : '—'}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs font-semibold text-slate-900 tabular-nums">
                        {formatDurationShort(emp.todayEffectiveMs)}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs text-slate-700 tabular-nums">
                        {emp.pendingSyncCount}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'corrections' && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 flex-1">
              <div>
                <label className="block text-[11px] font-medium text-slate-600">Estado</label>
                <select
                  value={corrStatusFilter}
                  onChange={(e) => setCorrStatusFilter(e.target.value as '' | CorrectionStatus)}
                  className="mt-1 min-h-[38px] w-full rounded-lg border border-slate-300 bg-white px-2.5 text-xs"
                >
                  <option value="">Todos</option>
                  <option value="pending">Pendientes</option>
                  <option value="approved">Aprobadas</option>
                  <option value="rejected">Rechazadas</option>
                  <option value="cancelled">Canceladas</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600">Empleado</label>
                <select
                  value={corrEmployeeFilter}
                  onChange={(e) => setCorrEmployeeFilter(e.target.value)}
                  className="mt-1 min-h-[38px] w-full rounded-lg border border-slate-300 bg-white px-2.5 text-xs"
                >
                  <option value="">Todos</option>
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600">Tipo</label>
                <select
                  value={corrKindFilter}
                  onChange={(e) => setCorrKindFilter(e.target.value as '' | CorrectionKind)}
                  className="mt-1 min-h-[38px] w-full rounded-lg border border-slate-300 bg-white px-2.5 text-xs"
                >
                  <option value="">Todos</option>
                  <option value="void_event">Anular evento</option>
                  <option value="void_day">Anular jornada completa</option>
                  <option value="change_time">Cambiar hora</option>
                  <option value="add_event">Añadir fichaje</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600">Desde</label>
                <input
                  type="date"
                  value={corrFromFilter}
                  onChange={(e) => setCorrFromFilter(e.target.value)}
                  className="mt-1 min-h-[38px] w-full rounded-lg border border-slate-300 px-2.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600">Hasta</label>
                <input
                  type="date"
                  value={corrToFilter}
                  onChange={(e) => setCorrToFilter(e.target.value)}
                  className="mt-1 min-h-[38px] w-full rounded-lg border border-slate-300 px-2.5 text-xs"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setAdminCorrInitialKind('add_event');
                  setAdminCorrInitialDate(undefined);
                  setShowAdminCorrModal(true);
                }}
                className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700 whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Crear para empleado
              </button>

              <button
                type="button"
                onClick={() => handleOpenAdminVoidDay()}
                className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border border-rose-300 bg-white px-3.5 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 whitespace-nowrap"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Anular jornada completa
              </button>
            </div>
          </div>

          {corrections.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              No hay solicitudes de corrección con los filtros actuales.
            </div>
          ) : (
            <div className="space-y-3">
              {corrections.map((c) => {
                const isOwnRequest = c.requestedBy === currentUserId;
                return (
                  <article
                    key={c.id}
                    className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-3"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-bold text-slate-900">
                          {c.employeeName} ·{' '}
                          {c.kind === 'void_event'
                            ? 'Anulación de fichaje'
                            : c.kind === 'void_day'
                              ? 'Anulación de jornada completa'
                              : c.kind === 'change_time'
                                ? 'Cambio de hora'
                                : 'Fichaje olvidado'}
                        </h3>
                        <p className="text-xs text-slate-500">
                          Solicitado por {c.requestedByName ?? c.requestedByEmail} ·{' '}
                          {getMadridDateKey(c.createdAt)} {formatMadridTime(c.createdAt)}
                        </p>
                      </div>
                      <span className="text-xs font-semibold text-slate-700 uppercase">
                        {c.status}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-xl border border-slate-100 bg-slate-50 p-3.5 text-xs">
                      <div>
                        <p className="text-slate-500">
                          {c.kind === 'void_day' ? 'Jornada afectada' : 'Fichaje original'}
                        </p>
                        <p className="mt-0.5 font-mono font-semibold text-slate-900 tabular-nums">
                          {c.kind === 'void_day'
                            ? `${c.proposedChange.madridDateKey ?? c.preview.madridDateKey} (${
                                c.proposedChange.voidedEventSummaries?.length ?? 0
                              } registro(s))`
                            : c.targetEvent
                              ? `${c.targetEvent.type} · ${formatMadridTime(c.targetEvent.deviceDeclaredAt)}`
                              : 'No existía (olvido)'}
                        </p>
                      </div>
                      <div>
                        <p className="text-slate-500">Cambio propuesto (declarada)</p>
                        {c.kind === 'void_day' ? (
                          <div className="mt-0.5 space-y-0.5 font-mono text-[11px] font-semibold text-rose-700 tabular-nums">
                            <p>Anular todos los registros del día</p>
                            {c.proposedChange.voidedEventSummaries &&
                              c.proposedChange.voidedEventSummaries.length > 0 && (
                                <p className="font-normal text-slate-600">
                                  {c.proposedChange.voidedEventSummaries
                                    .map((ev) => `${ev.type} ${formatMadridTime(ev.deviceDeclaredAt)}`)
                                    .join(' · ')}
                                </p>
                              )}
                          </div>
                        ) : (
                          <p className="mt-0.5 font-mono font-semibold text-blue-700 tabular-nums">
                            {c.kind === 'void_event'
                              ? 'Anular evento original'
                              : c.proposedChange.declaredAtUtc
                                ? `${c.proposedChange.eventType ?? c.targetEvent?.type ?? ''} · ${formatMadridTime(c.proposedChange.declaredAtUtc)}`
                                : '—'}
                          </p>
                        )}
                      </div>
                      <div>
                        <p className="text-slate-500">Jornada antes → después</p>
                        <p className="mt-0.5 font-mono font-semibold text-slate-900 tabular-nums">
                          {formatMinutesShort(c.preview.beforeWorkedMinutes)} →{' '}
                          {formatMinutesShort(c.preview.afterWorkedMinutes)}
                        </p>
                      </div>
                    </div>

                    <p className="text-xs text-slate-700">
                      <strong>Motivo:</strong> {c.reason}
                    </p>

                    {c.status === 'pending' && (
                      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                        {isOwnRequest ? (
                          <p className="text-xs font-medium text-amber-700">
                            No puedes aprobar ni rechazar tus propias solicitudes; debe resolverlas otro administrador.
                          </p>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleApproveCorrection(c)}
                              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
                            >
                              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                              Aprobar
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setRejectingId(c.id);
                                setRejectNote('');
                              }}
                              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-rose-300 bg-white px-4 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                            >
                              <XCircle className="h-4 w-4" aria-hidden="true" />
                              Rechazar
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {rejectingId === c.id && (
                      <form onSubmit={handleConfirmReject} className="mt-3 flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          required
                          value={rejectNote}
                          onChange={(e) => setRejectNote(e.target.value)}
                          placeholder="Motivo obligatorio del rechazo..."
                          className="min-h-[40px] flex-1 rounded-xl border border-rose-300 px-3 text-xs"
                        />
                        <button
                          type="submit"
                          className="min-h-[40px] rounded-xl bg-rose-600 px-4 text-xs font-semibold text-white hover:bg-rose-700"
                        >
                          Confirmar rechazo
                        </button>
                        <button
                          type="button"
                          onClick={() => setRejectingId(null)}
                          className="min-h-[40px] rounded-xl border border-slate-200 px-3 text-xs font-semibold text-slate-700"
                        >
                          Cancelar
                        </button>
                      </form>
                    )}

                    {c.resolutionNote && (
                      <p className="text-xs text-slate-500">
                        Nota resolución ({c.resolvedByName ?? c.resolvedByEmail}): {c.resolutionNote}
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {tab === 'sessions' && (
        <section className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-semibold">Empleado / Fecha</th>
                  <th className="px-4 py-3 font-semibold">Estado</th>
                  <th className="px-4 py-3 font-semibold">Trabajado</th>
                  <th className="px-4 py-3 font-semibold">Planificado</th>
                  <th className="px-4 py-3 font-semibold">Delta</th>
                  <th className="px-4 py-3 font-semibold">Anomalías</th>
                  <th className="px-4 py-3 font-semibold text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {workSessions.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-900">
                        {employeeNameMap.get(s.employeeId) ?? s.employeeId}
                      </p>
                      <p className="font-mono text-slate-500 tabular-nums">
                        {s.madridDate} · {formatMadridTime(s.startUtc)} –{' '}
                        {s.endUtc ? formatMadridTime(s.endUtc) : 'Abierta'}
                      </p>
                    </td>
                    <td className="px-4 py-3 font-semibold text-slate-800">{s.status}</td>
                    <td className="px-4 py-3 font-mono tabular-nums">{s.workedMinutes} min</td>
                    <td className="px-4 py-3 font-mono tabular-nums">{s.plannedMinutes} min</td>
                    <td className="px-4 py-3 font-mono tabular-nums">
                      {s.deltaMinutes >= 0 ? `+${s.deltaMinutes}` : s.deltaMinutes} min
                    </td>
                    <td className="px-4 py-3 text-amber-800">
                      {s.anomalyFlags.length === 0
                        ? 'Sin incidencias'
                        : s.anomalyFlags.map((f) => ANOMALY_LABELS[f]).join(' · ')}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {s.status !== 'voided' && (
                        <button
                          type="button"
                          onClick={() => handleOpenAdminVoidDay(s.employeeId, s.madridDate)}
                          className="inline-flex min-h-[32px] items-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 whitespace-nowrap"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                          Anular jornada
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'employees' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleCreateEmployee}
            className="lg:col-span-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-xs space-y-4"
          >
            <h2 className="text-lg font-semibold text-slate-900">Alta de empleado / usuario</h2>
            <div>
              <label className="block text-xs font-medium text-slate-600">Nombre completo</label>
              <input
                type="text"
                required
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Marta Gómez"
                className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Email de acceso</label>
              <input
                type="email"
                required
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="marta@mitaclock.es"
                className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">
                Contraseña inicial (mín. 6 caracteres)
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600">Rol</label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as UserRole)}
                  className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="employee">Empleado</option>
                  <option value="admin">Administrador</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600">
                  external_ref MiTa
                </label>
                <input
                  type="text"
                  value={newExternalRef}
                  onChange={(e) => setNewExternalRef(e.target.value)}
                  placeholder="MITA-EMP-104"
                  className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <button
              type="submit"
              className="min-h-[46px] w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700"
            >
              Crear usuario
            </button>
          </form>

          <div className="lg:col-span-7 rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-xs">
            <ul className="divide-y divide-slate-100">
              {employees.map((emp) => (
                <li key={emp.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{emp.name}</p>
                    <p className="text-xs text-slate-500">
                      {emp.email} · {emp.externalRef ?? 'Sin external_ref'} ·{' '}
                      <span className={emp.status === 'active' ? 'text-emerald-700' : 'text-rose-700'}>
                        {emp.status === 'active' ? 'Activo' : 'Desactivado'}
                      </span>
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggleEmployeeStatus(emp)}
                    className="min-h-[38px] rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    {emp.status === 'active' ? 'Desactivar' : 'Reactivar'}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {tab === 'breaks' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <form
            onSubmit={handleCreateBreakType}
            className="lg:col-span-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-xs space-y-4"
          >
            <h2 className="text-lg font-semibold text-slate-900">Nuevo tipo de pausa</h2>
            <div>
              <label className="block text-xs font-medium text-slate-600">Código</label>
              <input
                type="text"
                required
                value={breakCode}
                onChange={(e) => setBreakCode(e.target.value)}
                placeholder="MEDICO"
                className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 text-sm uppercase"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Nombre visible</label>
              <input
                type="text"
                required
                value={breakName}
                onChange={(e) => setBreakName(e.target.value)}
                placeholder="Asistencia médica"
                className="mt-1 min-h-[44px] w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={breakPaid}
                onChange={(e) => setBreakPaid(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600"
              />
              Pausa retribuida (informativo para MiTa)
            </label>
            <button
              type="submit"
              className="min-h-[46px] w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700"
            >
              Añadir tipo de pausa
            </button>
          </form>

          <div className="lg:col-span-7 rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-xs">
            <ul className="divide-y divide-slate-100">
              {breakTypes.map((bt) => (
                <li key={bt.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{bt.name}</p>
                    <p className="text-xs text-slate-500">
                      Código: <span className="font-mono">{bt.code}</span> ·{' '}
                      {bt.isPaid ? 'Retribuida' : 'No retribuida'} ·{' '}
                      {bt.isActive ? 'Activa' : 'Inactiva'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggleBreakActive(bt)}
                    className="min-h-[38px] rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    {bt.isActive ? 'Desactivar' : 'Activar'}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {tab === 'audit_outbox' && (
        <div className="space-y-6">
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  Outbox de correcciones hacia MiTaGateway ({outboxItems.length})
                </h2>
                <p className="text-xs text-slate-500">
                  Solo entran correcciones aprobadas. Envío idempotente con reintentos.
                </p>
              </div>
              <button
                type="button"
                onClick={handleProcessOutbox}
                className="min-h-[40px] rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
              >
                Procesar outbox ahora
              </button>
            </div>

            {outboxItems.length === 0 ? (
              <p className="text-xs text-slate-500">No hay entregas en el outbox todavía.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Idempotency Key</th>
                      <th className="px-4 py-2.5 font-semibold">Empleado / Sesión</th>
                      <th className="px-4 py-2.5 font-semibold">Estado</th>
                      <th className="px-4 py-2.5 font-semibold">Intentos</th>
                      <th className="px-4 py-2.5 font-semibold">ACK MiTa</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {outboxItems.map((item) => (
                      <tr key={item.id}>
                        <td className="px-4 py-2.5 font-mono text-[11px]">{item.idempotencyKey}</td>
                        <td className="px-4 py-2.5">
                          <p className="font-semibold text-slate-900">{item.payload.employeeName}</p>
                          <p className="font-mono text-[11px] text-slate-500">
                            Sesión: {item.payload.sessionId ?? 'N/A'}
                          </p>
                        </td>
                        <td className="px-4 py-2.5 font-semibold">{item.status}</td>
                        <td className="px-4 py-2.5 font-mono tabular-nums">{item.attempts}</td>
                        <td className="px-4 py-2.5 font-mono text-[11px]">
                          {item.externalAckRef ?? item.lastError ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs space-y-4">
            <h2 className="text-lg font-semibold text-slate-900">
              Registro inmutable de auditoría (audit_log)
            </h2>
            {auditEntries.length === 0 ? (
              <p className="text-xs text-slate-500">Sin entradas de auditoría registradas.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Fecha UTC</th>
                      <th className="px-4 py-2.5 font-semibold">Actor</th>
                      <th className="px-4 py-2.5 font-semibold">Acción</th>
                      <th className="px-4 py-2.5 font-semibold">IP / Agente</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {auditEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td className="px-4 py-2.5 font-mono text-[11px] tabular-nums">
                          {entry.createdAt}
                        </td>
                        <td className="px-4 py-2.5">{entry.actorEmail ?? entry.actorUserId}</td>
                        <td className="px-4 py-2.5 font-mono font-semibold">{entry.action}</td>
                        <td className="px-4 py-2.5 text-[11px] text-slate-500">
                          {entry.ipAddress} · {entry.userAgent}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {tab === 'mita' && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Contrato REST de sincronización MiTa v2.0 (Laravel 12)
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Endpoints activos: <span className="font-mono">GET /api/mita/v1/events</span> y{' '}
                <span className="font-mono">POST /api/mita/v1/confirm</span>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={mitaFilter}
                onChange={(e) => setMitaFilter(e.target.value as 'all' | 'enviado' | 'confirmado')}
                className="min-h-[40px] rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800"
              >
                <option value="all">Todos los estados</option>
                <option value="enviado">Solo enviados (pendientes MiTa)</option>
                <option value="confirmado">Solo confirmados</option>
              </select>

              <button
                type="button"
                onClick={handleConfirmPendingMita}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700"
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Confirmar lote en MiTa v2.0
              </button>
            </div>
          </div>

          {mitaEvents.length === 0 ? (
            <p className="text-sm text-slate-500">No hay eventos registrados para este filtro.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Empleado / Ref MiTa</th>
                    <th className="px-4 py-3 font-semibold">Evento / Origen</th>
                    <th className="px-4 py-3 font-semibold">Origen hora</th>
                    <th className="px-4 py-3 font-semibold">Declarado UTC</th>
                    <th className="px-4 py-3 font-semibold">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {mitaEvents.map((ev) => (
                    <tr key={ev.event_id}>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-slate-900">{ev.employee_name}</p>
                        <p className="font-mono text-[11px] text-slate-500">
                          {ev.employee_external_ref ?? ev.employee_id}
                        </p>
                      </td>
                      <td className="px-4 py-3 font-mono font-semibold text-slate-800">
                        {ev.type}
                        {ev.break_type_code ? ` (${ev.break_type_code})` : ''}
                        <span className="block font-sans text-[11px] font-normal text-slate-500">
                          source={ev.source}
                          {ev.corrects_event_id ? ` · corrige ${ev.corrects_event_id.slice(0, 8)}` : ''}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{ev.time_source}</td>
                      <td className="px-4 py-3 font-mono text-slate-600 tabular-nums">
                        {ev.device_declared_at_utc}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            ev.sync_status === 'confirmado'
                              ? 'font-semibold text-emerald-700'
                              : 'font-semibold text-blue-700'
                          }
                        >
                          {ev.sync_status}
                        </span>
                        {ev.mita_ack_ref && (
                          <span className="block font-mono text-[11px] text-slate-400">
                            {ev.mita_ack_ref}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <CorrectionModal
        open={showAdminCorrModal}
        employeeId={adminCorrEmployeeId}
        targetEvent={null}
        initialKind={adminCorrInitialKind}
        initialDateKey={adminCorrInitialDate}
        initialEventType="shift_end"
        existingEvents={adminCorrEvents}
        breakTypes={breakTypes}
        adminEmployees={employees}
        onSelectEmployeeId={setAdminCorrEmployeeId}
        onClose={() => {
          setShowAdminCorrModal(false);
          setAdminCorrInitialKind('add_event');
          setAdminCorrInitialDate(undefined);
        }}
        onSubmit={handleCreateAdminCorrection}
      />
    </div>
  );
};

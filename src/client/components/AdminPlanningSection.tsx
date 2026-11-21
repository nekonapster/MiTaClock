import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Copy,
  Edit2,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import { api, ApiError } from '../api';
import {
  addDaysToDateKey,
  enumerateDateKeys,
  formatMadridTime,
  formatMinutesShort,
  getMadridDateKey,
  getMadridIsoWeekday,
  getMondayOfWeek,
} from '../../shared/timeEngine';
import { computePlannedShiftBounds } from '../../shared/planningEngine';
import type {
  ClockPolicy,
  DayOff,
  DayOffType,
  Employee,
  OverrunPolicy,
  PlannedShift,
  ShiftTemplate,
} from '../../shared/types';

interface AdminPlanningSectionProps {
  employees: Employee[];
  onChanged?: () => Promise<void> | void;
}

const WEEKDAY_LABELS = [
  { num: 1, short: 'L', full: 'Lun' },
  { num: 2, short: 'M', full: 'Mar' },
  { num: 3, short: 'X', full: 'Mié' },
  { num: 4, short: 'J', full: 'Jue' },
  { num: 5, short: 'V', full: 'Vie' },
  { num: 6, short: 'S', full: 'Sáb' },
  { num: 7, short: 'D', full: 'Dom' },
];

const DAY_OFF_LABELS: Record<DayOffType, string> = {
  free: 'Día libre',
  holiday: 'Festivo',
  absence: 'Ausencia',
};

export const AdminPlanningSection: React.FC<AdminPlanningSectionProps> = ({
  employees,
  onChanged,
}) => {
  const todayKey = getMadridDateKey(new Date().toISOString());
  const [viewMode, setViewMode] = useState<'week_employee' | 'all_day'>('week_employee');
  const [selectedMonday, setSelectedMonday] = useState<string>(() => getMondayOfWeek(todayKey));
  const [selectedDay, setSelectedDay] = useState<string>(todayKey);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('');

  const [shifts, setShifts] = useState<PlannedShift[]>([]);
  const [templates, setTemplates] = useState<ShiftTemplate[]>([]);
  const [dayOffs, setDayOffs] = useState<DayOff[]>([]);
  const [policy, setPolicy] = useState<ClockPolicy | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Formulario jornada concreta (crear / editar)
  const [editingShiftId, setEditingShiftId] = useState<string | null>(null);
  const [shiftEmpId, setShiftEmpId] = useState<string>('');
  const [shiftDate, setShiftDate] = useState<string>(todayKey);
  const [shiftStart, setShiftStart] = useState<string>('08:00');
  const [shiftEnd, setShiftEnd] = useState<string>('15:00');
  const [shiftCrossesMidnight, setShiftCrossesMidnight] = useState<boolean>(false);
  const [shiftBreakMin, setShiftBreakMin] = useState<number>(0);
  const [shiftFacility, setShiftFacility] = useState<string>('CENTRO-01');
  const [shiftProject, setShiftProject] = useState<string>('OP-DIARIA');

  // Formulario plantilla fija
  const [tplEmpId, setTplEmpId] = useState<string>('');
  const [tplName, setTplName] = useState<string>('Turno mañanas L-V');
  const [tplWeekdays, setTplWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [tplStart, setTplStart] = useState<string>('08:00');
  const [tplEnd, setTplEnd] = useState<string>('15:00');
  const [tplCrossesMidnight, setTplCrossesMidnight] = useState<boolean>(false);
  const [tplBreakMin, setTplBreakMin] = useState<number>(0);
  const [tplFacility, setTplFacility] = useState<string>('CENTRO-01');
  const [tplProject, setTplProject] = useState<string>('OP-DIARIA');
  const [tplValidFrom, setTplValidFrom] = useState<string>(todayKey);
  const [tplValidTo, setTplValidTo] = useState<string>('');

  // Rango generación desde plantilla
  const [genTemplateId, setGenTemplateId] = useState<string>('');
  const [genFrom, setGenFrom] = useState<string>(() => getMondayOfWeek(todayKey));
  const [genTo, setGenTo] = useState<string>(() => addDaysToDateKey(getMondayOfWeek(todayKey), 13));

  // Días libres / festivos / ausencias
  const [offEmpId, setOffEmpId] = useState<string>('');
  const [offDate, setOffDate] = useState<string>(todayKey);
  const [offType, setOffType] = useState<DayOffType>('holiday');
  const [offNote, setOffNote] = useState<string>('');

  // Política de reloj
  const [polPastEnd, setPolPastEnd] = useState<number>(15);
  const [polFlagAfter, setPolFlagAfter] = useState<number>(120);
  const [polMaxOpenH, setPolMaxOpenH] = useState<number>(12);
  const [polMaxDailyM, setPolMaxDailyM] = useState<number>(720);
  const [polToleranceM, setPolToleranceM] = useState<number>(30);
  const [polOverrun, setPolOverrun] = useState<OverrunPolicy>('flag_only');
  const [polRequirePlan, setPolRequirePlan] = useState<boolean>(false);

  const nonAdminEmployees = useMemo(
    () => employees.filter((e) => e.status === 'active'),
    [employees],
  );

  useEffect(() => {
    if (!selectedEmployeeId && nonAdminEmployees.length > 0) {
      const firstEmp =
        nonAdminEmployees.find((e) => e.role === 'employee') ?? nonAdminEmployees[0];
      setSelectedEmployeeId(firstEmp.id);
      setShiftEmpId(firstEmp.id);
      setTplEmpId(firstEmp.id);
    }
  }, [nonAdminEmployees, selectedEmployeeId]);

  const weekDates = useMemo(
    () => enumerateDateKeys(selectedMonday, addDaysToDateKey(selectedMonday, 6)),
    [selectedMonday],
  );

  const loadPlanning = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rangeFrom = viewMode === 'week_employee' ? selectedMonday : selectedDay;
      const rangeTo =
        viewMode === 'week_employee' ? addDaysToDateKey(selectedMonday, 6) : selectedDay;

      const [shiftsRes, tplRes, offRes, polRes] = await Promise.all([
        api.getAdminShifts({
          from: rangeFrom,
          to: rangeTo,
          employeeId:
            viewMode === 'week_employee' && selectedEmployeeId ? selectedEmployeeId : undefined,
        }),
        api.getShiftTemplates(),
        api.getDayOffs(),
        api.getClockPolicy(),
      ]);

      setShifts(shiftsRes.shifts);
      setTemplates(tplRes.templates);
      if (!genTemplateId && tplRes.templates.length > 0) {
        setGenTemplateId(tplRes.templates[0].id);
      }
      setDayOffs(offRes.dayOffs);
      setPolicy(polRes.policy);
      setPolPastEnd(polRes.policy.pastPlannedEndMinutes);
      setPolFlagAfter(polRes.policy.flagAfterEndMinutes);
      setPolMaxOpenH(polRes.policy.maxOpenHours);
      setPolMaxDailyM(polRes.policy.maxDailyMinutes);
      setPolToleranceM(polRes.policy.scheduleToleranceMinutes);
      setPolOverrun(polRes.policy.overrunPolicy);
      setPolRequirePlan(polRes.policy.requirePlannedShift);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo cargar la planificación.');
    } finally {
      setLoading(false);
    }
  }, [viewMode, selectedMonday, selectedDay, selectedEmployeeId, genTemplateId]);

  useEffect(() => {
    loadPlanning();
  }, [loadPlanning]);

  const draftPreview = useMemo(
    () =>
      computePlannedShiftBounds({
        madridDateKey: shiftDate,
        startTimeMadrid: shiftStart,
        endTimeMadrid: shiftEnd,
        crossesMidnight: shiftCrossesMidnight,
        plannedBreakMinutes: shiftBreakMin,
      }),
    [shiftDate, shiftStart, shiftEnd, shiftCrossesMidnight, shiftBreakMin],
  );

  const handleSaveShift = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      if (editingShiftId) {
        await api.updateAdminShift(editingShiftId, {
          madridDateKey: shiftDate,
          startTimeMadrid: shiftStart,
          endTimeMadrid: shiftEnd,
          crossesMidnight: shiftCrossesMidnight,
          plannedBreakMinutes: shiftBreakMin,
          facilityRef: shiftFacility.trim() || null,
          projectRef: shiftProject.trim() || null,
        });
        setNotice('Jornada planificada actualizada (registrado en audit_log).');
        setEditingShiftId(null);
      } else {
        await api.createAdminShift({
          employeeId: shiftEmpId || selectedEmployeeId,
          madridDateKey: shiftDate,
          startTimeMadrid: shiftStart,
          endTimeMadrid: shiftEnd,
          crossesMidnight: shiftCrossesMidnight,
          plannedBreakMinutes: shiftBreakMin,
          facilityRef: shiftFacility.trim() || null,
          projectRef: shiftProject.trim() || null,
        });
        setNotice('Jornada planificada creada (registrado en audit_log).');
      }
      await loadPlanning();
      await onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar la jornada.');
    }
  };

  const handleStartEditShift = (shift: PlannedShift) => {
    setEditingShiftId(shift.id);
    setShiftEmpId(shift.employeeId);
    setShiftDate(shift.madridDateKey);
    setShiftStart(formatMadridTime(shift.startUtc));
    setShiftEnd(formatMadridTime(shift.endUtc));
    setShiftCrossesMidnight(getMadridDateKey(shift.endUtc) !== shift.madridDateKey);
    setShiftBreakMin(shift.plannedBreakMinutes);
    setShiftFacility(shift.facilityRef ?? '');
    setShiftProject(shift.projectRef ?? '');
  };

  const handleDeleteShift = async (shiftId: string) => {
    setError(null);
    setNotice(null);
    try {
      await api.deleteAdminShift(shiftId);
      setNotice('Jornada planificada eliminada (registrado en audit_log).');
      await loadPlanning();
      await onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo eliminar la jornada.');
    }
  };

  const handleCopyPreviousWeek = async () => {
    setError(null);
    setNotice(null);
    try {
      const sourceMonday = addDaysToDateKey(selectedMonday, -7);
      const res = await api.copyWeekShifts({
        sourceMonday,
        targetMonday: selectedMonday,
        employeeId: viewMode === 'week_employee' ? selectedEmployeeId : undefined,
      });
      setNotice(
        `Semana copiada desde ${sourceMonday}: ${res.createdCount} creada(s), ${res.skippedCount} omitida(s).`,
      );
      await loadPlanning();
      await onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo copiar la semana anterior.');
    }
  };

  const handleCreateTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await api.createShiftTemplate({
        employeeId: tplEmpId || selectedEmployeeId,
        name: tplName,
        weekdays: tplWeekdays,
        startTimeMadrid: tplStart,
        endTimeMadrid: tplEnd,
        crossesMidnight: tplCrossesMidnight,
        plannedBreakMinutes: tplBreakMin,
        facilityRef: tplFacility.trim() || null,
        projectRef: tplProject.trim() || null,
        validFrom: tplValidFrom,
        validTo: tplValidTo.trim() || null,
      });
      setGenTemplateId(res.template.id);
      setNotice('Plantilla fija guardada.');
      await loadPlanning();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear la plantilla.');
    }
  };

  const handleGenerateFromTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!genTemplateId) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api.generateShiftsFromTemplate({
        templateId: genTemplateId,
        from: genFrom,
        to: genTo,
      });
      setNotice(
        `Jornadas generadas: ${res.createdCount} nueva(s), ${res.skippedCount} día(s) omitidos (ya existentes o días libres/festivos).`,
      );
      await loadPlanning();
      await onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al generar jornadas.');
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    setError(null);
    try {
      await api.deleteShiftTemplate(id);
      await loadPlanning();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo eliminar la plantilla.');
    }
  };

  const handleCreateDayOff = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await api.createDayOff({
        employeeId: offEmpId || null,
        madridDate: offDate,
        type: offType,
        note: offNote.trim() || null,
      });
      setOffNote('');
      setNotice('Día libre / festivo registrado.');
      await loadPlanning();
      await onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar el día libre.');
    }
  };

  const handleDeleteDayOff = async (id: string) => {
    setError(null);
    try {
      await api.deleteDayOff(id);
      await loadPlanning();
      await onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Error al eliminar día libre.');
    }
  };

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await api.updateClockPolicy({
        pastPlannedEndMinutes: polPastEnd,
        flagAfterEndMinutes: polFlagAfter,
        maxOpenHours: polMaxOpenH,
        maxDailyMinutes: polMaxDailyM,
        scheduleToleranceMinutes: polToleranceM,
        overrunPolicy: polOverrun,
        requirePlannedShift: polRequirePlan,
      });
      setNotice('Política de relojes y vigilancia actualizada.');
      await loadPlanning();
      await onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo guardar la política.');
    }
  };

  const employeeNameMap = new Map(employees.map((e) => [e.id, e.name]));

  return (
    <div className="space-y-6">
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

      {/* Cabecera de vistas semanal / diaria */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setViewMode('week_employee')}
              className={`min-h-[40px] rounded-xl px-3.5 py-2 text-xs font-semibold transition ${
                viewMode === 'week_employee'
                  ? 'bg-blue-600 text-white'
                  : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              Vista semanal por empleado
            </button>
            <button
              type="button"
              onClick={() => setViewMode('all_day')}
              className={`min-h-[40px] rounded-xl px-3.5 py-2 text-xs font-semibold transition ${
                viewMode === 'all_day'
                  ? 'bg-blue-600 text-white'
                  : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              Todos los empleados por día
            </button>
          </div>

          <button
            type="button"
            onClick={handleCopyPreviousWeek}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            Copiar semana anterior
          </button>
        </div>

        {viewMode === 'week_employee' ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-slate-600">Empleado:</label>
                <select
                  value={selectedEmployeeId}
                  onChange={(e) => setSelectedEmployeeId(e.target.value)}
                  className="min-h-[40px] rounded-xl border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800"
                >
                  {nonAdminEmployees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name} ({emp.role === 'admin' ? 'Admin' : 'Empleado'})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedMonday(addDaysToDateKey(selectedMonday, -7))}
                  className="min-h-[38px] rounded-lg border border-slate-200 p-2 hover:bg-slate-50"
                  aria-label="Semana anterior"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="font-mono text-xs font-semibold text-slate-800 tabular-nums">
                  {selectedMonday} → {addDaysToDateKey(selectedMonday, 6)}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedMonday(addDaysToDateKey(selectedMonday, 7))}
                  className="min-h-[38px] rounded-lg border border-slate-200 p-2 hover:bg-slate-50"
                  aria-label="Semana siguiente"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-2.5">
              {weekDates.map((dKey) => {
                const isoDay = getMadridIsoWeekday(dKey);
                const wLabel = WEEKDAY_LABELS.find((w) => w.num === isoDay)?.full ?? '';
                const dayShift = shifts.find((s) => s.madridDateKey === dKey);
                const dayOff = dayOffs.find(
                  (d) =>
                    d.madridDate === dKey &&
                    (d.employeeId === null || d.employeeId === selectedEmployeeId),
                );
                return (
                  <div
                    key={dKey}
                    className={`rounded-xl border p-3 text-xs space-y-2 ${
                      dayOff
                        ? 'border-amber-200 bg-amber-50/60'
                        : dayShift
                          ? 'border-blue-200 bg-blue-50/40'
                          : 'border-slate-200 bg-slate-50/50'
                    }`}
                  >
                    <div className="flex items-baseline justify-between">
                      <span className="font-bold text-slate-900">{wLabel}</span>
                      <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                        {dKey.slice(5)}
                      </span>
                    </div>

                    {dayOff && (
                      <p className="font-semibold text-amber-800">
                        {DAY_OFF_LABELS[dayOff.type]}
                        {dayOff.note ? ` · ${dayOff.note}` : ''}
                      </p>
                    )}

                    {dayShift ? (
                      <div className="space-y-1">
                        <p className="font-mono font-bold text-slate-900 tabular-nums">
                          {formatMadridTime(dayShift.startUtc)}–{formatMadridTime(dayShift.endUtc)}
                        </p>
                        <p className="text-[11px] text-slate-600">
                          {formatMinutesShort(dayShift.plannedMinutes)} · {dayShift.source}
                        </p>
                        {dayShift.facilityRef && (
                          <p className="text-[11px] text-slate-500 truncate">{dayShift.facilityRef}</p>
                        )}
                        <div className="flex items-center gap-1 pt-1">
                          <button
                            type="button"
                            onClick={() => handleStartEditShift(dayShift)}
                            className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-slate-100"
                            title="Editar jornada"
                          >
                            <Edit2 className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteShift(dayShift.id)}
                            className="rounded-md border border-rose-200 bg-white p-1.5 text-rose-700 hover:bg-rose-50"
                            title="Eliminar jornada"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingShiftId(null);
                          setShiftEmpId(selectedEmployeeId);
                          setShiftDate(dKey);
                        }}
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 hover:underline"
                      >
                        <Plus className="h-3 w-3" /> Añadir turno
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-xs font-medium text-slate-600">Fecha:</label>
              <input
                type="date"
                value={selectedDay}
                onChange={(e) => setSelectedDay(e.target.value)}
                className="min-h-[40px] rounded-xl border border-slate-300 px-3 text-xs font-mono"
              />
              {loading && <span className="text-xs text-slate-500">Cargando...</span>}
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Empleado</th>
                    <th className="px-4 py-2.5 font-semibold">Horario Madrid</th>
                    <th className="px-4 py-2.5 font-semibold">Planificado</th>
                    <th className="px-4 py-2.5 font-semibold">Instalación / Proyecto</th>
                    <th className="px-4 py-2.5 font-semibold">Origen</th>
                    <th className="px-4 py-2.5 font-semibold">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {nonAdminEmployees.map((emp) => {
                    const shift = shifts.find((s) => s.employeeId === emp.id);
                    const off = dayOffs.find(
                      (d) =>
                        d.madridDate === selectedDay &&
                        (d.employeeId === null || d.employeeId === emp.id),
                    );
                    return (
                      <tr key={emp.id}>
                        <td className="px-4 py-3 font-semibold text-slate-900">{emp.name}</td>
                        <td className="px-4 py-3 font-mono tabular-nums">
                          {shift
                            ? `${formatMadridTime(shift.startUtc)} – ${formatMadridTime(shift.endUtc)}`
                            : off
                              ? DAY_OFF_LABELS[off.type]
                              : 'Sin turno'}
                        </td>
                        <td className="px-4 py-3 font-mono tabular-nums">
                          {shift ? formatMinutesShort(shift.plannedMinutes) : '—'}
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {shift ? `${shift.facilityRef ?? '—'} · ${shift.projectRef ?? '—'}` : '—'}
                        </td>
                        <td className="px-4 py-3 font-mono">{shift ? shift.source : '—'}</td>
                        <td className="px-4 py-3">
                          {shift ? (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleStartEditShift(shift)}
                                className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                              >
                                Editar
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteShift(shift.id)}
                                className="rounded-lg border border-rose-200 px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50"
                              >
                                Borrar
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingShiftId(null);
                                setShiftEmpId(emp.id);
                                setShiftDate(selectedDay);
                              }}
                              className="text-[11px] font-semibold text-blue-700 hover:underline"
                            >
                              Asignar turno
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Crear / editar jornada concreta + Plantillas fijas */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <form
          onSubmit={handleSaveShift}
          className="lg:col-span-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-3.5"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <Calendar className="h-4 w-4 text-blue-600" aria-hidden="true" />
              {editingShiftId ? 'Editar jornada planificada' : 'Nueva jornada concreta'}
            </h2>
            {editingShiftId && (
              <button
                type="button"
                onClick={() => setEditingShiftId(null)}
                className="text-xs font-semibold text-slate-500 hover:text-slate-800"
              >
                Cancelar edición
              </button>
            )}
          </div>

          {!editingShiftId && (
            <div>
              <label className="block text-xs font-medium text-slate-600">Empleado</label>
              <select
                value={shiftEmpId || selectedEmployeeId}
                onChange={(e) => setShiftEmpId(e.target.value)}
                className="mt-1 min-h-[42px] w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
              >
                {nonAdminEmployees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600">Fecha negocio</label>
              <input
                type="date"
                required
                value={shiftDate}
                onChange={(e) => setShiftDate(e.target.value)}
                className="mt-1 min-h-[42px] w-full rounded-xl border border-slate-300 px-3 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Pausa planificada (min)</label>
              <input
                type="number"
                min={0}
                value={shiftBreakMin}
                onChange={(e) => setShiftBreakMin(Number(e.target.value))}
                className="mt-1 min-h-[42px] w-full rounded-xl border border-slate-300 px-3 text-sm font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600">Inicio (Madrid)</label>
              <input
                type="time"
                required
                value={shiftStart}
                onChange={(e) => setShiftStart(e.target.value)}
                className="mt-1 min-h-[42px] w-full rounded-xl border border-slate-300 px-3 text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Fin (Madrid)</label>
              <input
                type="time"
                required
                value={shiftEnd}
                onChange={(e) => setShiftEnd(e.target.value)}
                className="mt-1 min-h-[42px] w-full rounded-xl border border-slate-300 px-3 text-sm font-mono"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={shiftCrossesMidnight}
              onChange={(e) => setShiftCrossesMidnight(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600"
            />
            Turno nocturno (cruza medianoche al día siguiente)
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600">facility_ref</label>
              <input
                type="text"
                value={shiftFacility}
                onChange={(e) => setShiftFacility(e.target.value)}
                placeholder="PISCINA-25M"
                className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-3 text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">project_ref</label>
              <input
                type="text"
                value={shiftProject}
                onChange={(e) => setShiftProject(e.target.value)}
                placeholder="CURSOS"
                className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-3 text-xs"
              />
            </div>
          </div>

          <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-700 font-mono tabular-nums">
            {draftPreview.ok
              ? `Duración neta planificada: ${formatMinutesShort(draftPreview.plannedMinutes)} (${draftPreview.plannedMinutes} min)`
              : draftPreview.reason}
          </p>

          <button
            type="submit"
            disabled={!draftPreview.ok}
            className="min-h-[44px] w-full rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {editingShiftId ? 'Guardar cambios' : 'Crear jornada planificada'}
          </button>
        </form>

        {/* Plantillas fijas + Generar jornadas */}
        <div className="lg:col-span-7 space-y-5">
          <form
            onSubmit={handleCreateTemplate}
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-3.5"
          >
            <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <CalendarPlus className="h-4 w-4 text-blue-600" aria-hidden="true" />
              Plantillas de jornada fija
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600">Empleado</label>
                <select
                  value={tplEmpId || selectedEmployeeId}
                  onChange={(e) => setTplEmpId(e.target.value)}
                  className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 bg-white px-3 text-xs"
                >
                  {nonAdminEmployees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600">Nombre plantilla</label>
                <input
                  type="text"
                  required
                  value={tplName}
                  onChange={(e) => setTplName(e.target.value)}
                  className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-3 text-xs"
                />
              </div>
            </div>

            <div>
              <span className="block text-xs font-medium text-slate-600 mb-1.5">Días de la semana</span>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAY_LABELS.map((w) => {
                  const active = tplWeekdays.includes(w.num);
                  return (
                    <button
                      key={w.num}
                      type="button"
                      onClick={() =>
                        setTplWeekdays((prev) =>
                          prev.includes(w.num)
                            ? prev.filter((x) => x !== w.num)
                            : [...prev, w.num].sort((a, b) => a - b),
                        )
                      }
                      className={`min-h-[36px] min-w-[38px] rounded-lg border px-2 text-xs font-semibold ${
                        active
                          ? 'border-blue-600 bg-blue-50 text-blue-700'
                          : 'border-slate-200 bg-white text-slate-600'
                      }`}
                    >
                      {w.short}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600">Inicio</label>
                <input
                  type="time"
                  required
                  value={tplStart}
                  onChange={(e) => setTplStart(e.target.value)}
                  className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-2.5 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600">Fin</label>
                <input
                  type="time"
                  required
                  value={tplEnd}
                  onChange={(e) => setTplEnd(e.target.value)}
                  className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-2.5 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600">Pausa (min)</label>
                <input
                  type="number"
                  min={0}
                  value={tplBreakMin}
                  onChange={(e) => setTplBreakMin(Number(e.target.value))}
                  className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-2.5 text-xs font-mono"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-slate-700 pt-5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tplCrossesMidnight}
                  onChange={(e) => setTplCrossesMidnight(e.target.checked)}
                />
                Nocturno
              </label>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600">Vigente desde</label>
                <input
                  type="date"
                  required
                  value={tplValidFrom}
                  onChange={(e) => setTplValidFrom(e.target.value)}
                  className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-2.5 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600">Vigente hasta</label>
                <input
                  type="date"
                  value={tplValidTo}
                  onChange={(e) => setTplValidTo(e.target.value)}
                  className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-2.5 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600">facility_ref</label>
                <input
                  type="text"
                  value={tplFacility}
                  onChange={(e) => setTplFacility(e.target.value)}
                  className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-2.5 text-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600">project_ref</label>
                <input
                  type="text"
                  value={tplProject}
                  onChange={(e) => setTplProject(e.target.value)}
                  className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-2.5 text-xs"
                />
              </div>
            </div>

            <button
              type="submit"
              className="min-h-[42px] rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Guardar plantilla
            </button>
          </form>

          {/* Generar jornadas desde plantilla */}
          <form
            onSubmit={handleGenerateFromTemplate}
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-3"
          >
            <h3 className="text-sm font-semibold text-slate-900">
              Generar jornadas desde plantilla (sin duplicar ni pisar días libres)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-600">Plantilla</label>
                <select
                  value={genTemplateId}
                  onChange={(e) => setGenTemplateId(e.target.value)}
                  className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 bg-white px-3 text-xs"
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {employeeNameMap.get(t.employeeId) ?? t.employeeId} · {t.name} ({t.startTimeMadrid}–{t.endTimeMadrid})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600">Desde</label>
                <input
                  type="date"
                  required
                  value={genFrom}
                  onChange={(e) => setGenFrom(e.target.value)}
                  className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-2.5 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600">Hasta</label>
                <input
                  type="date"
                  required
                  value={genTo}
                  onChange={(e) => setGenTo(e.target.value)}
                  className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-2.5 text-xs font-mono"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="submit"
                disabled={!genTemplateId}
                className="min-h-[42px] rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Generar jornadas
              </button>
              <span className="text-xs text-slate-500">
                {templates.length} plantilla(s) registradas
              </span>
            </div>

            {templates.length > 0 && (
              <ul className="divide-y divide-slate-100 pt-2">
                {templates.map((t) => (
                  <li key={t.id} className="flex items-center justify-between py-2 text-xs">
                    <span>
                      <strong className="text-slate-900">
                        {employeeNameMap.get(t.employeeId) ?? t.employeeId}
                      </strong>{' '}
                      · {t.name} ·{' '}
                      <span className="font-mono">
                        {t.startTimeMadrid}–{t.endTimeMadrid}
                      </span>{' '}
                      (días {t.weekdays.join(',')})
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDeleteTemplate(t.id)}
                      className="text-rose-700 font-semibold hover:underline"
                    >
                      Eliminar
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </form>
        </div>
      </div>

      {/* Días libres / festivos y Política de reloj */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-4">
          <h2 className="text-base font-semibold text-slate-900">
            Días libres, festivos y ausencias
          </h2>
          <form onSubmit={handleCreateDayOff} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600">Ámbito</label>
              <select
                value={offEmpId}
                onChange={(e) => setOffEmpId(e.target.value)}
                className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 bg-white px-3 text-xs"
              >
                <option value="">Todo el centro (festivo general)</option>
                {nonAdminEmployees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Fecha</label>
              <input
                type="date"
                required
                value={offDate}
                onChange={(e) => setOffDate(e.target.value)}
                className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-3 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Tipo</label>
              <select
                value={offType}
                onChange={(e) => setOffType(e.target.value as DayOffType)}
                className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 bg-white px-3 text-xs"
              >
                <option value="holiday">Festivo</option>
                <option value="free">Día libre</option>
                <option value="absence">Ausencia</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600">Nota</label>
              <input
                type="text"
                value={offNote}
                onChange={(e) => setOffNote(e.target.value)}
                placeholder="Ej. Festivo nacional"
                className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-3 text-xs"
              />
            </div>
            <div className="sm:col-span-2">
              <button
                type="submit"
                className="min-h-[40px] rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              >
                Marcar día no laborable
              </button>
            </div>
          </form>

          {dayOffs.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {dayOffs.map((d) => (
                <li key={d.id} className="flex items-center justify-between py-2 text-xs">
                  <span>
                    <strong className="font-mono tabular-nums">{d.madridDate}</strong> ·{' '}
                    {DAY_OFF_LABELS[d.type]} ·{' '}
                    {d.employeeId ? employeeNameMap.get(d.employeeId) ?? d.employeeId : 'Todo el centro'}
                    {d.note ? ` (${d.note})` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDeleteDayOff(d.id)}
                    className="text-rose-700 font-semibold hover:underline"
                  >
                    Quitar
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <form
          onSubmit={handleSavePolicy}
          className="lg:col-span-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs space-y-4"
        >
          <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-blue-600" aria-hidden="true" />
            Política de relojes y umbrales de vigilancia
          </h2>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-600">
                Aviso fin + (min)
              </label>
              <input
                type="number"
                min={0}
                value={polPastEnd}
                onChange={(e) => setPolPastEnd(Number(e.target.value))}
                className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-3 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600">
                Flagged fin + (min)
              </label>
              <input
                type="number"
                min={1}
                value={polFlagAfter}
                onChange={(e) => setPolFlagAfter(Number(e.target.value))}
                className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-3 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600">
                Incompleta tras (h)
              </label>
              <input
                type="number"
                min={1}
                value={polMaxOpenH}
                onChange={(e) => setPolMaxOpenH(Number(e.target.value))}
                className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-3 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600">
                Máx. diario (min)
              </label>
              <input
                type="number"
                min={60}
                value={polMaxDailyM}
                onChange={(e) => setPolMaxDailyM(Number(e.target.value))}
                className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-3 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600">
                Tolerancia horario (min)
              </label>
              <input
                type="number"
                min={0}
                value={polToleranceM}
                onChange={(e) => setPolToleranceM(Number(e.target.value))}
                className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 px-3 text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600">
                overrun_policy
              </label>
              <select
                value={polOverrun}
                onChange={(e) => setPolOverrun(e.target.value as OverrunPolicy)}
                className="mt-1 min-h-[40px] w-full rounded-xl border border-slate-300 bg-white px-2.5 text-xs"
              >
                <option value="flag_only">flag_only (sigue contando)</option>
                <option value="cap_provisional">cap_provisional (tope provisional)</option>
              </select>
            </div>
          </div>

          <label className="flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={polRequirePlan}
              onChange={(e) => setPolRequirePlan(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600"
            />
            Exigir jornada planificada para poder iniciar fichaje (require_planned_shift)
          </label>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="submit"
              className="min-h-[42px] rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
            >
              Guardar política
            </button>
            {policy && (
              <span className="text-[11px] text-slate-500">
                Última actualización: {policy.updatedAt.slice(0, 16).replace('T', ' ')} UTC
              </span>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};

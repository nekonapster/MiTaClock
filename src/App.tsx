import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Clock, Loader2, LogOut, Shield } from 'lucide-react';
import { api, ApiError, subscribeServerStatus, type ServerConnectionStatus } from './client/api';
import {
  enqueueOfflineEvent,
  getQueuedEvents,
  queuedToClockEvent,
  removeQueuedEvents,
} from './client/offlineQueue';
import { useOnlineStatus } from './client/hooks/useOnlineStatus';
import { buildShiftsFromEvents, computeWorkState } from './shared/timeEngine';
import type {
  BreakType,
  ClockEvent,
  ClockEventType,
  CorrectionKind,
  CorrectionRequest,
  PlannedShift,
  ProposedCorrectionChange,
  QueuedClockEvent,
  UserPublic,
  WorkSession,
} from './shared/types';
import { LoginView } from './client/components/LoginView';
import { ChangePasswordView } from './client/components/ChangePasswordView';
import { ClockDashboard } from './client/components/ClockDashboard';
import { HistoryView } from './client/components/HistoryView';
import { AdminPanel } from './client/components/AdminPanel';
import { PWAInstallButton } from './client/components/PWAInstallButton';
import { CorrectionModal } from './client/components/CorrectionModal';

type MainTab = 'clock' | 'history' | 'admin';

export default function App() {
  const [user, setUser] = useState<UserPublic | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [activeTab, setActiveTab] = useState<MainTab>('clock');

  const [serverEvents, setServerEvents] = useState<ClockEvent[]>([]);
  const [queuedEvents, setQueuedEvents] = useState<QueuedClockEvent[]>([]);
  const [breakTypes, setBreakTypes] = useState<BreakType[]>([]);
  const [plannedShifts, setPlannedShifts] = useState<PlannedShift[]>([]);
  const [todayPlannedShift, setTodayPlannedShift] = useState<PlannedShift | null>(null);
  const [activeSession, setActiveSession] = useState<WorkSession | null>(null);
  const [showOverrunPrompt, setShowOverrunPrompt] = useState(false);
  const [overrunMinutes, setOverrunMinutes] = useState(0);
  const [clockPolicyMaxOpenHours, setClockPolicyMaxOpenHours] = useState<number>(12);
  const [workSessions, setWorkSessions] = useState<WorkSession[]>([]);
  const [corrections, setCorrections] = useState<CorrectionRequest[]>([]);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [actionBusy, setActionBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerConnectionStatus>('idle');

  // Estado del modal de corrección del empleado
  const [corrModalOpen, setCorrModalOpen] = useState(false);
  const [corrTargetEvent, setCorrTargetEvent] = useState<ClockEvent | null>(null);
  const [corrInitialKind, setCorrInitialKind] = useState<CorrectionKind | undefined>(undefined);
  const [corrInitialDate, setCorrInitialDate] = useState<string | undefined>(undefined);
  const [corrInitialEventType, setCorrInitialEventType] = useState<
    Exclude<ClockEventType, 'event_void'> | undefined
  >(undefined);

  const isOnline = useOnlineStatus();

  useEffect(() => subscribeServerStatus(setServerStatus), []);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let mounted = true;
    api
      .getMe()
      .then((res) => {
        if (mounted) {
          setUser(res.user);
          if (res.user.role === 'admin') {
            setActiveTab('admin');
          }
        }
      })
      .catch(() => {
        // Sesión no iniciada
      })
      .finally(() => {
        if (mounted) setAuthChecked(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const refreshEmployeeData = useCallback(async (currentUser: UserPublic) => {
    if (!currentUser.employeeId || currentUser.mustChangePassword) return;

    const queued = await getQueuedEvents(currentUser.employeeId);
    setQueuedEvents(queued);

    try {
      const [eventsRes, breaksRes, shiftsRes, todayRes, sessionsRes, correctionsRes] =
        await Promise.all([
          api.getClockEvents(),
          api.getBreakTypes(),
          api.getNextShifts().catch(() => ({ shifts: [] })),
          api.getTodayShift().catch(() => null),
          api.getWorkSessions().catch(() => ({ sessions: [] })),
          api.getCorrections().catch(() => ({ corrections: [] })),
        ]);
      setServerEvents(eventsRes.events);
      setBreakTypes(breaksRes.breakTypes);
      setPlannedShifts(shiftsRes.shifts);
      setWorkSessions(sessionsRes.sessions);
      setCorrections(correctionsRes.corrections);
      if (todayRes) {
        setTodayPlannedShift(todayRes.plannedShift);
        setActiveSession(todayRes.activeSession);
        setShowOverrunPrompt(todayRes.showOverrunPrompt);
        setOverrunMinutes(todayRes.overrunMinutes);
        setClockPolicyMaxOpenHours(todayRes.policy.maxOpenHours);
      }
    } catch {
      // Si estamos sin conexión o el servidor está despertando, mantenemos estado local con la cola IndexedDB
    }
  }, []);

  const syncOutbox = useCallback(
    async (currentUser: UserPublic) => {
      if (!currentUser.employeeId || currentUser.mustChangePassword || !navigator.onLine) return;
      const queued = await getQueuedEvents(currentUser.employeeId);
      if (queued.length === 0) return;

      setSyncing(true);
      try {
        const res = await api.submitBatchEvents(queued);
        const syncedIds = res.results.map((r) => r.event.id);
        await removeQueuedEvents(syncedIds);
        await refreshEmployeeData(currentUser);
      } catch {
        // Reintentará automáticamente cuando termine de despertar el servidor o vuelva la conexión
      } finally {
        setSyncing(false);
      }
    },
    [refreshEmployeeData],
  );

  useEffect(() => {
    if (!user || user.mustChangePassword) return;
    refreshEmployeeData(user);
  }, [user, refreshEmployeeData]);

  useEffect(() => {
    if (user && !user.mustChangePassword && isOnline) {
      syncOutbox(user);
    }
  }, [user, isOnline, syncOutbox]);

  useEffect(() => {
    if (!user?.employeeId || user.mustChangePassword || !isOnline || queuedEvents.length === 0) return;
    const id = window.setInterval(() => {
      syncOutbox(user);
    }, 15_000);
    return () => window.clearInterval(id);
  }, [user, isOnline, queuedEvents.length, syncOutbox]);

  useEffect(() => {
    if (!user?.employeeId || user.mustChangePassword || !isOnline) return;
    const id = window.setInterval(() => {
      refreshEmployeeData(user);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [user, isOnline, refreshEmployeeData]);

  const combinedEvents = useMemo(() => {
    const serverIds = new Set(serverEvents.map((e) => e.id));
    const pendingAsClock = queuedEvents
      .filter((q) => !serverIds.has(q.id))
      .map(queuedToClockEvent);
    return [...serverEvents, ...pendingAsClock];
  }, [serverEvents, queuedEvents]);

  const incompleteSessionIds = useMemo(
    () => new Set(workSessions.filter((s) => s.status === 'incomplete').map((s) => s.id)),
    [workSessions],
  );

  const snapshot = useMemo(
    () =>
      computeWorkState(combinedEvents, nowMs, breakTypes, {
        maxOpenHours: clockPolicyMaxOpenHours,
        incompleteSessionIds,
      }),
    [combinedEvents, nowMs, breakTypes, clockPolicyMaxOpenHours, incompleteSessionIds],
  );

  const shifts = useMemo(
    () => buildShiftsFromEvents(combinedEvents, breakTypes, nowMs),
    [combinedEvents, breakTypes, nowMs],
  );

  const anomalySessions = useMemo(
    () =>
      workSessions.filter(
        (s) => s.status !== 'voided' && s.anomalyFlags.length > 0 && !s.hasApprovedCorrection,
      ),
    [workSessions],
  );

  const sendOrQueueEvents = async (drafts: QueuedClockEvent[]) => {
    if (!user?.employeeId) return;
    setErrorMessage(null);
    setActionBusy(true);

    try {
      if (!navigator.onLine) {
        for (const item of drafts) {
          await enqueueOfflineEvent({ ...item, offline: true });
        }
        await refreshEmployeeData(user);
        return;
      }

      try {
        await api.submitBatchEvents(drafts);
        await refreshEmployeeData(user);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'PASSWORD_CHANGE_REQUIRED') {
          setUser((prev) => (prev ? { ...prev, mustChangePassword: true } : prev));
        } else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          setErrorMessage(err.message);
        } else {
          // Si el servidor está despertando (502/503/504, timeout o red), se guarda en IndexedDB como pendiente sin error
          for (const item of drafts) {
            await enqueueOfflineEvent({ ...item, offline: true });
          }
          await refreshEmployeeData(user);
        }
      }
    } finally {
      setActionBusy(false);
    }
  };

  const handleClockAction = async (
    type: Exclude<ClockEventType, 'event_void'>,
    options?: {
      breakTypeId?: string | null;
      assignmentRef?: string | null;
      facilityRef?: string | null;
      projectRef?: string | null;
    },
  ) => {
    if (!user?.employeeId) return;
    const now = new Date();
    const event: QueuedClockEvent = {
      id: crypto.randomUUID(),
      employeeId: user.employeeId,
      type,
      breakTypeId: options?.breakTypeId ?? null,
      deviceDeclaredAt: now.toISOString(),
      deviceOffsetMs: -now.getTimezoneOffset() * 60 * 1000,
      assignmentRef: options?.assignmentRef ?? null,
      projectRef: options?.projectRef ?? null,
      facilityRef: options?.facilityRef ?? null,
      offline: !navigator.onLine,
      createdAtMs: now.getTime(),
    };
    await sendOrQueueEvents([event]);
  };

  const handleConfirmFinishShift = async () => {
    if (!user?.employeeId) return;
    const now = new Date();
    const offsetMs = -now.getTimezoneOffset() * 60 * 1000;
    const batch: QueuedClockEvent[] = [];

    if (snapshot.workState === 'en_pausa') {
      batch.push({
        id: crypto.randomUUID(),
        employeeId: user.employeeId,
        type: 'break_end',
        breakTypeId: null,
        deviceDeclaredAt: now.toISOString(),
        deviceOffsetMs: offsetMs,
        assignmentRef: snapshot.activeAssignmentRef,
        projectRef: snapshot.activeProjectRef,
        facilityRef: snapshot.activeFacilityRef,
        offline: !navigator.onLine,
        createdAtMs: now.getTime(),
      });
    }

    batch.push({
      id: crypto.randomUUID(),
      employeeId: user.employeeId,
      type: 'shift_end',
      breakTypeId: null,
      deviceDeclaredAt: new Date(now.getTime() + 1).toISOString(),
      deviceOffsetMs: offsetMs,
      assignmentRef: snapshot.activeAssignmentRef,
      projectRef: snapshot.activeProjectRef,
      facilityRef: snapshot.activeFacilityRef,
      offline: !navigator.onLine,
      createdAtMs: now.getTime() + 1,
    });

    await sendOrQueueEvents(batch);
  };

  const handleOpenCorrectionForEvent = (ev: ClockEvent) => {
    setCorrTargetEvent(ev);
    setCorrInitialKind('change_time');
    setCorrInitialDate(undefined);
    setCorrInitialEventType(undefined);
    setCorrModalOpen(true);
  };

  const handleOpenForgotClock = () => {
    setCorrTargetEvent(null);
    setCorrInitialKind('add_event');
    setCorrInitialDate(undefined);
    setCorrInitialEventType('shift_end');
    setCorrModalOpen(true);
  };

  const handleOpenVoidDay = (madridDateKey?: string) => {
    setCorrTargetEvent(null);
    setCorrInitialKind('void_day');
    setCorrInitialDate(madridDateKey);
    setCorrInitialEventType(undefined);
    setCorrModalOpen(true);
  };

  const handleReviewAnomaly = (session: WorkSession) => {
    const relatedShift = shifts.find((s) => s.id === session.id);
    if (session.status === 'incomplete') {
      setCorrTargetEvent(null);
      setCorrInitialKind('add_event');
      setCorrInitialDate(session.madridDate);
      setCorrInitialEventType('shift_end');
      setCorrModalOpen(true);
      return;
    }
    const endEv = relatedShift?.events.find((e) => e.type === 'shift_end') ?? relatedShift?.events[0] ?? null;
    setCorrTargetEvent(endEv);
    setCorrInitialKind(endEv ? 'change_time' : 'add_event');
    setCorrInitialDate(session.madridDate);
    setCorrInitialEventType('shift_end');
    setCorrModalOpen(true);
  };

  const handleSubmitCorrection = async (payload: {
    employeeId: string;
    targetEventId: string | null;
    kind: CorrectionKind;
    reason: string;
    proposedChange?: ProposedCorrectionChange;
  }) => {
    if (!user) return;
    await api.createCorrection(
      {
        targetEventId: payload.targetEventId,
        kind: payload.kind,
        reason: payload.reason,
        proposedChange: payload.proposedChange,
      },
      crypto.randomUUID(),
    );
    await refreshEmployeeData(user);
    setActiveTab('history');
  };

  const handleCancelCorrection = async (correctionId: string) => {
    if (!user) return;
    await api.cancelCorrection(correctionId);
    await refreshEmployeeData(user);
  };

  const handleAcknowledgeOverrun = async (sessionId: string, reason: string) => {
    await api.acknowledgeSessionOverrun(sessionId, reason);
    if (user) {
      await refreshEmployeeData(user);
    }
  };

  const handleLogout = async () => {
    await api.logout().catch(() => {});
    setUser(null);
    setServerEvents([]);
    setQueuedEvents([]);
    setWorkSessions([]);
    setCorrections([]);
    setTodayPlannedShift(null);
    setActiveSession(null);
    setShowOverrunPrompt(false);
    setOverrunMinutes(0);
    setErrorMessage(null);
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-2 p-6 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" aria-hidden="true" />
        <p className="text-sm font-medium text-slate-700">
          {serverStatus === 'connecting'
            ? 'Conectando con el servidor…'
            : 'Cargando MiTa Clock...'}
        </p>
      </div>
    );
  }

  if (!user) {
    return (
      <LoginView
        onAuthenticated={(loggedInUser) => {
          setUser(loggedInUser);
          setActiveTab(loggedInUser.role === 'admin' ? 'admin' : 'clock');
        }}
      />
    );
  }

  if (user.mustChangePassword) {
    return (
      <ChangePasswordView
        user={user}
        onPasswordChanged={(updatedUser) => {
          setUser(updatedUser);
          setActiveTab(updatedUser.role === 'admin' ? 'admin' : 'clock');
        }}
        onLogout={handleLogout}
      />
    );
  }

  const navItems: Array<{ id: MainTab; label: string; icon: typeof Clock }> = [
    { id: 'clock', label: 'Fichar', icon: Clock },
    { id: 'history', label: 'Historial', icon: CalendarDays },
    ...(user.role === 'admin' ? [{ id: 'admin' as const, label: 'Admin', icon: Shield }] : []),
  ];

  return (
    <div className="min-h-screen bg-slate-50 pb-20 md:pb-8">
      <header className="sticky top-0 z-30 h-14 border-b border-slate-200 bg-white/95 backdrop-blur-md">
        <div className="mx-auto flex h-full max-w-6xl items-center justify-between gap-8 px-4 sm:px-6">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            MiTa Clock
          </span>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            {navItems.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'text-blue-600 font-semibold underline decoration-2 underline-offset-8'
                      : 'hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <PWAInstallButton />
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              Salir
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {serverStatus === 'connecting' && (
          <div
            role="status"
            aria-live="polite"
            className="mb-4 flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs font-medium text-blue-800"
          >
            <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden="true" />
            Conectando con el servidor… tus fichajes locales siguen seguros en este dispositivo.
          </div>
        )}
        {activeTab === 'clock' && (
          <ClockDashboard
            employeeName={user.employeeName || user.email}
            externalRef={user.externalRef}
            snapshot={snapshot}
            breakTypes={breakTypes}
            plannedShifts={plannedShifts}
            todayPlannedShift={todayPlannedShift}
            activeSession={activeSession}
            showOverrunPrompt={showOverrunPrompt}
            overrunMinutes={overrunMinutes}
            anomalySessions={anomalySessions}
            queuedCount={queuedEvents.length}
            isOnline={isOnline}
            syncing={syncing}
            actionBusy={actionBusy}
            errorMessage={errorMessage}
            onClockAction={handleClockAction}
            onConfirmFinishShift={handleConfirmFinishShift}
            onSyncNow={() => syncOutbox(user)}
            onReviewAnomaly={handleReviewAnomaly}
            onAcknowledgeOverrun={handleAcknowledgeOverrun}
          />
        )}

        {activeTab === 'history' && (
          <HistoryView
            shifts={shifts}
            allEvents={combinedEvents}
            sessions={workSessions}
            corrections={corrections}
            onRequestCorrectionForEvent={handleOpenCorrectionForEvent}
            onForgotClockIn={handleOpenForgotClock}
            onRequestVoidDay={handleOpenVoidDay}
            onCancelCorrection={handleCancelCorrection}
          />
        )}

        {activeTab === 'admin' && user.role === 'admin' && (
          <AdminPanel currentUserId={user.id} />
        )}
      </main>

      {user.employeeId && (
        <CorrectionModal
          open={corrModalOpen}
          employeeId={user.employeeId}
          targetEvent={corrTargetEvent}
          initialKind={corrInitialKind}
          initialDateKey={corrInitialDate}
          initialEventType={corrInitialEventType}
          existingEvents={combinedEvents}
          breakTypes={breakTypes}
          onClose={() => setCorrModalOpen(false)}
          onSubmit={handleSubmitCorrection}
        />
      )}

      <nav
        aria-label="Navegación principal móvil"
        className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur-md md:hidden"
      >
        <div
          className={`grid h-16 items-center ${
            navItems.length === 3 ? 'grid-cols-3' : 'grid-cols-2'
          }`}
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`flex min-h-[44px] flex-col items-center justify-center gap-1 transition-colors ${
                  active ? 'text-blue-600' : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                <span className="text-[11px] font-semibold tracking-tight">{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

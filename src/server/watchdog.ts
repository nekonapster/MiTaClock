import crypto from 'node:crypto';
import { addDaysToDateKey, getMadridDateKey } from '../shared/timeEngine.ts';
import { buildWorkSessionsProjection, DEFAULT_ANOMALY_CONFIG } from '../shared/correctionsEngine.ts';
import type { AnomalyConfig, SessionIncident, WorkSession } from '../shared/types.ts';
import type { MitaGateway } from './mitaGateway.ts';
import type { ClockRepository } from './repository.ts';

export interface WatchdogRunSummary {
  checkedEmployees: number;
  flaggedCount: number;
  incompleteCount: number;
  openedIncidents: SessionIncident[];
}

export async function evaluateEmployeeSessionsWithWatchdog(params: {
  repo: ClockRepository;
  gateway: MitaGateway;
  employeeId: string;
  employeeExternalRef: string | null;
  nowMs: number;
  anomalyConfig?: AnomalyConfig;
}): Promise<{ sessions: WorkSession[]; openedIncidents: SessionIncident[] }> {
  const { repo, gateway, employeeId, employeeExternalRef, nowMs, anomalyConfig } = params;
  const nowIso = new Date(nowMs).toISOString();
  const todayKey = getMadridDateKey(nowIso);

  const [policy, events, breakTypes, plannedShifts, corrections, existingSessions] =
    await Promise.all([
      repo.getClockPolicy(),
      repo.listClockEvents({ employeeId }),
      repo.listBreakTypes(false),
      gateway.getAssignments({
        employeeId,
        employeeExternalRef,
        fromDateKey: addDaysToDateKey(todayKey, -14),
        toDateKey: addDaysToDateKey(todayKey, 2),
      }),
      repo.listCorrections({ employeeId }),
      repo.listWorkSessions(employeeId),
    ]);

  const existingById = new Map(existingSessions.map((s) => [s.id, s]));
  const sessions = buildWorkSessionsProjection({
    employeeId,
    events,
    breakTypes,
    plannedShifts,
    corrections,
    config: anomalyConfig ?? DEFAULT_ANOMALY_CONFIG,
    policy,
    existingSessionsById: existingById,
    nowMs,
  });

  await repo.replaceEmployeeWorkSessions(employeeId, sessions);

  const existingIncidents = await repo.listSessionIncidents();
  const openIncidentSessionIds = new Set(
    existingIncidents
      .filter((inc) => inc.status !== 'resolved')
      .map((inc) => inc.sessionId),
  );

  const openedIncidents: SessionIncident[] = [];
  for (const s of sessions) {
    if (s.status === 'flagged' || s.status === 'incomplete') {
      const hadOpen = openIncidentSessionIds.has(s.id);
      const incident = await repo.upsertSessionIncident({
        id: crypto.randomUUID(),
        sessionId: s.id,
        employeeId: s.employeeId,
        kind: s.status === 'incomplete' ? 'incomplete_shift' : 'flagged_overrun',
        madridDate: s.madridDate,
        shiftStartUtc: s.startUtc,
        plannedEndUtc: s.plannedEndUtc ?? null,
        detectedAt: nowIso,
      });
      if (!hadOpen) {
        openedIncidents.push(incident);
      }
    } else if (s.status === 'closed' || s.status === 'voided') {
      await repo.resolveIncidentsForSession(s.id, nowIso, null);
    }
  }

  const persistedSessions = await repo.listWorkSessions(employeeId);
  for (const s of persistedSessions) {
    if (s.status === 'closed' || s.status === 'voided') {
      await repo.resolveIncidentsForSession(s.id, nowIso, null);
    }
  }

  return { sessions, openedIncidents };
}

export async function runSessionWatchdog(params: {
  repo: ClockRepository;
  gateway: MitaGateway;
  nowProvider?: () => Date;
  anomalyConfig?: AnomalyConfig;
}): Promise<WatchdogRunSummary> {
  const { repo, gateway, nowProvider = () => new Date(), anomalyConfig } = params;
  const nowMs = nowProvider().getTime();
  const employees = await repo.listEmployees(true);

  let flaggedCount = 0;
  let incompleteCount = 0;
  const openedIncidents: SessionIncident[] = [];

  for (const emp of employees) {
    const res = await evaluateEmployeeSessionsWithWatchdog({
      repo,
      gateway,
      employeeId: emp.id,
      employeeExternalRef: emp.externalRef,
      nowMs,
      anomalyConfig,
    });
    for (const s of res.sessions) {
      if (s.status === 'flagged') flaggedCount += 1;
      if (s.status === 'incomplete') incompleteCount += 1;
    }
    openedIncidents.push(...res.openedIncidents);
  }

  return {
    checkedEmployees: employees.length,
    flaggedCount,
    incompleteCount,
    openedIncidents,
  };
}

export function createWatchdogCoordinator(params: {
  repo: ClockRepository;
  gateway: MitaGateway;
  nowProvider?: () => Date;
  anomalyConfig?: AnomalyConfig;
  minIntervalMs?: number;
}) {
  const minIntervalMs = params.minIntervalMs ?? 30_000;
  let lastRunAtMs = 0;
  let inFlight: Promise<WatchdogRunSummary> | null = null;

  const runNow = async (force: boolean = false): Promise<WatchdogRunSummary | null> => {
    const now = Date.now();
    if (!force && inFlight) {
      return inFlight;
    }
    if (!force && now - lastRunAtMs < minIntervalMs) {
      return null;
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = runSessionWatchdog({
      repo: params.repo,
      gateway: params.gateway,
      nowProvider: params.nowProvider,
      anomalyConfig: params.anomalyConfig,
    })
      .then((summary) => {
        lastRunAtMs = Date.now();
        return summary;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };

  return { runNow };
}

export function startSessionWatchdogTimer(
  runner: () => Promise<WatchdogRunSummary | null>,
  intervalMs: number = 5 * 60 * 1000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    runner().catch((err) => {
      console.error(
        'Error en el proceso de vigilancia de sesiones:',
        err instanceof Error ? err.message : 'Error desconocido',
      );
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
}

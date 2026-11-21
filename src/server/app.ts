import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import {
  addDaysToDateKey,
  buildShiftsFromEvents,
  computeWorkState,
  formatMadridTime,
  getMadridDateKey,
  getMondayOfWeek,
  resolveRootEventId,
  validateTransition,
} from '../shared/timeEngine.ts';
import {
  buildWorkSessionsProjection,
  DEFAULT_ANOMALY_CONFIG,
  getEventsForDayVoid,
  simulateCorrectionAndPreview,
} from '../shared/correctionsEngine.ts';
import {
  buildDailySummary,
  computePlannedShiftBounds,
  expandTemplateInRange,
  findPlannedShiftForNow,
  findPlannedShiftForShift,
  isValidDateKey,
  validateNoShiftOverlap,
} from '../shared/planningEngine.ts';
import type {
  AdminOpenSessionView,
  AnomalyConfig,
  ClockEvent,
  ClockEventType,
  CorrectionKind,
  CorrectionStatus,
  DayOffType,
  InsertClockEventInput,
  OverrunPolicy,
  PlannedShift,
  ProposedCorrectionChange,
  SyncStatus,
  UserRole,
} from '../shared/types.ts';
import {
  clearSessionCookie,
  createAuthMiddleware,
  csrfProtection,
  LoginRateLimiter,
  requireAdmin,
  requirePasswordChanged,
  resolveJwtSecret,
  setSessionCookie,
  signSessionToken,
  type AuthenticatedRequest,
} from './auth.ts';
import { FakeMitaGateway, SimulatedMitaGateway, type MitaGateway } from './mitaGateway.ts';
import { sanitizeSecretString, type SqlExecutor } from './pgConnection.ts';
import type { ClockRepository } from './repository.ts';
import {
  createWatchdogCoordinator,
  evaluateEmployeeSessionsWithWatchdog,
  runSessionWatchdog,
} from './watchdog.ts';

export interface AppOptions {
  jwtSecret?: string;
  allowDemoAuth?: boolean;
  mitaSyncKey?: string;
  maxLoginAttempts?: number;
  loginWindowMs?: number;
  mitaGateway?: MitaGateway;
  correctionLookbackDays?: number;
  anomalyConfig?: AnomalyConfig;
  nowProvider?: () => Date;
  skipFirstLoginPasswordEnforcement?: boolean;
}

const VALID_EVENT_TYPES = new Set<ClockEventType>(['shift_start', 'shift_end', 'break_start', 'break_end']);
const VALID_CORRECTION_KINDS = new Set<CorrectionKind>(['void_event', 'change_time', 'add_event', 'void_day']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sendProblem(
  res: express.Response,
  status: number,
  title: string,
  detail: string,
  type: string = 'about:blank',
): void {
  res
    .status(status)
    .setHeader('Content-Type', 'application/problem+json; charset=utf-8')
    .json({
      type,
      title,
      status,
      detail,
      error: detail,
    });
}

function getClientIp(req: express.Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

function getUserAgent(req: express.Request): string {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' && ua.trim() ? ua.slice(0, 255) : 'unknown';
}

export function createApp(repo: ClockRepository, options: AppOptions = {}) {
  const app = express();
  const jwtSecret = resolveJwtSecret(options.jwtSecret);
  const allowDemoAuth =
    options.allowDemoAuth ?? (process.env.ALLOW_DEMO_AUTH !== 'false');
  const mitaSyncKey = options.mitaSyncKey ?? process.env.MITA_SYNC_KEY?.trim() ?? '';
  const correctionLookbackDays =
    options.correctionLookbackDays ?? Number(process.env.CORRECTION_LOOKBACK_DAYS || 7);
  const anomalyConfig: AnomalyConfig = options.anomalyConfig ?? DEFAULT_ANOMALY_CONFIG;
  const nowProvider = options.nowProvider ?? (() => new Date());

  const gateway: MitaGateway =
    options.mitaGateway ??
    ('getExecutor' in repo && typeof (repo as { getExecutor?: () => SqlExecutor }).getExecutor === 'function'
      ? new SimulatedMitaGateway((repo as unknown as { getExecutor: () => SqlExecutor }).getExecutor())
      : new FakeMitaGateway());

  gateway.bindPlannedShiftReader?.((filter) => repo.listPlannedShifts(filter));

  const watchdogCoordinator = createWatchdogCoordinator({
    repo,
    gateway,
    nowProvider,
    anomalyConfig,
    minIntervalMs: 30_000,
  });

  const rateLimiter = new LoginRateLimiter(
    options.maxLoginAttempts ?? 5,
    options.loginWindowMs ?? 15 * 60 * 1000,
  );
  const requireAuth = createAuthMiddleware(repo, jwtSecret);
  const enforcePasswordChanged: express.RequestHandler = options.skipFirstLoginPasswordEnforcement
    ? (_req, _res, next) => next()
    : requirePasswordChanged;

  async function rebuildSessionsForEmployee(employeeId: string): Promise<void> {
    const emp = await repo.findEmployeeById(employeeId);
    if (!emp) return;
    await evaluateEmployeeSessionsWithWatchdog({
      repo,
      gateway,
      employeeId: emp.id,
      employeeExternalRef: emp.externalRef,
      nowMs: nowProvider().getTime(),
      anomalyConfig,
    });
  }

  async function flushCorrectionOutbox(actorUserId: string, ip: string, ua: string) {
    const pending = await repo.listOutboxItems('pending');
    const failed = await repo.listOutboxItems('failed');
    const queue = [...pending, ...failed].filter((item) => item.attempts < 10);

    let sentCount = 0;
    let failedCount = 0;

    for (const item of queue) {
      try {
        const result = await gateway.sendCorrection(item.payload, item.idempotencyKey);
        const sentAt = nowProvider().toISOString();
        await repo.markOutboxSent(item.id, result.ackRef, sentAt);
        await repo.appendAuditLog({
          id: crypto.randomUUID(),
          actorUserId,
          action: 'mita.outbox_sent',
          entityType: 'mita_outbox',
          entityId: item.id,
          details: {
            correctionId: item.correctionId,
            sessionId: item.payload.sessionId,
            ackRef: result.ackRef,
          },
          ipAddress: ip,
          userAgent: ua,
          createdAt: sentAt,
        });
        sentCount += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error de envío al gateway MiTa';
        await repo.markOutboxFailed(item.id, msg);
        failedCount += 1;
      }
    }

    return { sentCount, failedCount };
  }

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Unifica todas las rutas bajo /api/v1/* manteniendo compatibilidad con /api/*
  app.use((req, _res, next) => {
    if (req.url.startsWith('/api/v1/mita/')) {
      req.url = req.url.replace(/^\/api\/v1\/mita\//, '/api/mita/v1/');
    } else if (
      /^\/api\/v1\/(auth|break-types|clock-events|health)(\/|\?|$)/.test(req.url) ||
      /^\/api\/v1\/admin\/(overview|employees|break-types)(\/|\?|$)/.test(req.url)
    ) {
      req.url = req.url.replace(/^\/api\/v1\//, '/api/');
    }
    next();
  });

  app.use('/api', csrfProtection);

  const handleHealth: express.RequestHandler = async (_req, res) => {
    const dbAlive = await repo.ping(2_500);
    if (!dbAlive) {
      res.status(503).json({
        ok: false,
        status: 'degraded',
        db: 'down',
        service: 'MiTa Clock',
        timezone: 'Europe/Madrid',
      });
      return;
    }
    res.json({
      ok: true,
      status: 'ok',
      db: 'up',
      service: 'MiTa Clock',
      timezone: 'Europe/Madrid',
    });
  };

  app.get('/health', handleHealth);
  app.get('/api/health', handleHealth);

  app.get('/api/auth/demo-accounts', async (_req, res) => {
    if (!allowDemoAuth) {
      res.json({ enabled: false, accounts: [] });
      return;
    }
    const accounts = await repo.listDemoAccounts();
    res.json({ enabled: true, accounts });
  });

  app.post('/api/auth/login', async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!email || !password) {
      res.status(400).json({ error: 'Introduce email y contraseña.' });
      return;
    }

    const rateKey = `${getClientIp(req)}:${email}`;
    const limitState = rateLimiter.isBlocked(rateKey);
    if (limitState.blocked) {
      res.status(429).json({
        error: `Demasiados intentos fallidos. Espera ${limitState.retryAfterSeconds} s antes de volver a intentarlo.`,
        retryAfterSeconds: limitState.retryAfterSeconds,
      });
      return;
    }

    const userRecord = await repo.findUserByEmail(email);
    const valid =
      Boolean(userRecord && userRecord.isActive && userRecord.passwordHash) &&
      bcrypt.compareSync(password, userRecord!.passwordHash!);

    if (!valid || !userRecord) {
      rateLimiter.recordFailure(rateKey);
      res.status(401).json({ error: 'Credenciales incorrectas o cuenta sin contraseña asignada.' });
      return;
    }

    rateLimiter.reset(rateKey);
    const publicUser = await repo.findUserPublicById(userRecord.id);
    if (!publicUser) {
      res.status(500).json({ error: 'No se pudo cargar el perfil de usuario.' });
      return;
    }

    const token = signSessionToken(
      { sub: userRecord.id, role: userRecord.role, email: userRecord.email },
      jwtSecret,
    );
    setSessionCookie(res, token, req);
    res.json({ user: publicUser, token });
  });

  app.post('/api/auth/demo-login', async (req, res) => {
    if (!allowDemoAuth) {
      res.status(403).json({ error: 'El acceso rápido de demostración está deshabilitado.' });
      return;
    }

    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) {
      res.status(400).json({ error: 'Selecciona una cuenta de ejemplo.' });
      return;
    }

    const rateKey = `demo:${getClientIp(req)}:${email}`;
    const limitState = rateLimiter.isBlocked(rateKey);
    if (limitState.blocked) {
      res.status(429).json({ error: 'Límite de solicitudes alcanzado.' });
      return;
    }

    const userRecord = await repo.findUserByEmail(email);
    if (!userRecord || !userRecord.isActive || !userRecord.isDemo) {
      rateLimiter.recordFailure(rateKey);
      res.status(404).json({ error: 'Cuenta de demostración no disponible.' });
      return;
    }

    const publicUser = await repo.findUserPublicById(userRecord.id);
    if (!publicUser) {
      res.status(500).json({ error: 'Error al iniciar sesión demo.' });
      return;
    }

    const token = signSessionToken(
      { sub: userRecord.id, role: userRecord.role, email: userRecord.email },
      jwtSecret,
    );
    setSessionCookie(res, token, req);
    res.json({ user: publicUser, token });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res, req);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ user: req.authUser });
  });

  app.post('/api/auth/change-password', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authUser = req.authUser!;
    const currentPassword =
      typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

    if (newPassword.length < 8) {
      res.status(422).json({
        error: 'La nueva contraseña debe tener al menos 8 caracteres.',
      });
      return;
    }

    const userRecord = await repo.findUserByEmail(authUser.email);
    if (!userRecord) {
      res.status(404).json({ error: 'Usuario no encontrado.' });
      return;
    }

    if (!userRecord.mustChangePassword && userRecord.passwordHash) {
      if (!currentPassword || !bcrypt.compareSync(currentPassword, userRecord.passwordHash)) {
        res.status(401).json({ error: 'La contraseña actual no es correcta.' });
        return;
      }
    }

    const nextHash = bcrypt.hashSync(newPassword, 10);
    await repo.updateUserPasswordHash(userRecord.id, nextHash, false);

    const updatedUser = await repo.findUserPublicById(userRecord.id);
    if (!updatedUser) {
      res.status(500).json({ error: 'No se pudo actualizar el perfil.' });
      return;
    }

    await repo.appendAuditLog({
      id: crypto.randomUUID(),
      actorUserId: userRecord.id,
      action: 'user.password_changed',
      entityType: 'user',
      entityId: userRecord.id,
      details: { firstLoginReset: userRecord.mustChangePassword },
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      createdAt: nowProvider().toISOString(),
    });

    const token = signSessionToken(
      { sub: updatedUser.id, role: updatedUser.role, email: updatedUser.email },
      jwtSecret,
    );
    setSessionCookie(res, token, req);
    res.json({ user: updatedUser });
  });

  // Bloquea cualquier ruta operativa hasta completar el cambio obligatorio de contraseña inicial
  app.use(
    ['/api/break-types', '/api/clock-events', '/api/v1/clock', '/api/admin', '/api/v1/admin'],
    requireAuth,
    enforcePasswordChanged,
  );

  app.get('/api/break-types', requireAuth, async (req: AuthenticatedRequest, res) => {
    const activeOnly = req.authUser?.role !== 'admin';
    const breakTypes = await repo.listBreakTypes(activeOnly);
    res.json({ breakTypes });
  });

  app.get('/api/clock-events', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authUser = req.authUser!;
    let employeeId = authUser.employeeId ?? undefined;

    if (authUser.role === 'admin' && typeof req.query.employeeId === 'string' && req.query.employeeId) {
      employeeId = req.query.employeeId;
    }

    if (!employeeId && authUser.role !== 'admin') {
      res.status(403).json({ error: 'El usuario no tiene perfil de empleado asociado.' });
      return;
    }

    const events = await repo.listClockEvents({
      employeeId,
      syncStatus:
        req.query.status === 'enviado' || req.query.status === 'confirmado'
          ? req.query.status
          : undefined,
    });
    res.json({ events });
  });

  app.post('/api/clock-events', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authUser = req.authUser!;
    if (!authUser.employeeId) {
      res.status(403).json({ error: 'Solo los perfiles con empleado asociado pueden fichar.' });
      return;
    }

    if (req.body?.employeeId && req.body.employeeId !== authUser.employeeId && authUser.role !== 'admin') {
      res.status(403).json({ error: 'No puedes registrar fichajes para otro empleado.' });
      return;
    }

    const targetEmployeeId =
      authUser.role === 'admin' && typeof req.body?.employeeId === 'string'
        ? req.body.employeeId
        : authUser.employeeId;

    const outcome = await processIncomingEvents(
      repo,
      gateway,
      targetEmployeeId,
      [req.body],
      nowProvider,
    );
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }

    await rebuildSessionsForEmployee(targetEmployeeId);
    const first = outcome.results[0];
    res.status(first.deduplicated ? 200 : 201).json(first);
  });

  app.post('/api/clock-events/batch', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authUser = req.authUser!;
    if (!authUser.employeeId) {
      res.status(403).json({ error: 'Solo los perfiles con empleado asociado pueden fichar.' });
      return;
    }

    const rawEvents = Array.isArray(req.body?.events) ? req.body.events : null;
    if (!rawEvents || rawEvents.length === 0) {
      res.status(400).json({ error: 'Debes enviar una lista no vacía en events.' });
      return;
    }

    const outcome = await processIncomingEvents(
      repo,
      gateway,
      authUser.employeeId,
      rawEvents,
      nowProvider,
    );
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }

    await rebuildSessionsForEmployee(authUser.employeeId);
    res.status(200).json({ results: outcome.results });
  });

  // =========================================================================
  // API v1: TURNOS PLANIFICADOS, SESIONES, ANOMALÍAS Y CORRECCIONES
  // =========================================================================

  app.get('/api/v1/clock/shifts/today', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authUser = req.authUser!;
    let employeeId = authUser.employeeId;

    if (
      authUser.role === 'admin' &&
      typeof req.query.employeeId === 'string' &&
      req.query.employeeId
    ) {
      employeeId = req.query.employeeId;
    }

    if (!employeeId) {
      sendProblem(res, 403, 'Sin perfil de empleado', 'El usuario no tiene empleado asociado.');
      return;
    }

    const emp = await repo.findEmployeeById(employeeId);
    if (!emp) {
      sendProblem(res, 404, 'Empleado no encontrado', 'No existe el empleado solicitado.');
      return;
    }

    const now = nowProvider();
    const nowMs = now.getTime();
    const todayKey = getMadridDateKey(now.toISOString());

    await rebuildSessionsForEmployee(emp.id);

    const [policy, assignments, sessions] = await Promise.all([
      repo.getClockPolicy(),
      gateway.getAssignments({
        employeeId: emp.id,
        employeeExternalRef: emp.externalRef,
        fromDateKey: addDaysToDateKey(todayKey, -1),
        toDateKey: addDaysToDateKey(todayKey, 1),
      }),
      repo.listWorkSessions(emp.id),
    ]);

    const plannedShift = findPlannedShiftForNow(emp.id, nowMs, assignments);
    const activeSession =
      sessions.find((s) => s.status === 'open' || s.status === 'flagged') ?? null;

    const refEndUtc = activeSession?.plannedEndUtc ?? plannedShift?.endUtc ?? null;
    const overrunMinutes =
      activeSession && refEndUtc
        ? Math.max(0, Math.round((nowMs - Date.parse(refEndUtc)) / 60_000))
        : 0;

    const showOverrunPrompt = Boolean(
      activeSession &&
        (activeSession.status === 'open' || activeSession.status === 'flagged') &&
        activeSession.anomalyFlags.includes('past_planned_end') &&
        !activeSession.overrunAcknowledged,
    );

    res.json({
      todayKey,
      plannedShift,
      activeSession,
      policy,
      showOverrunPrompt,
      overrunMinutes,
    });
  });

  app.get('/api/v1/clock/shifts/next', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authUser = req.authUser!;
    let employeeId = authUser.employeeId;

    if (
      authUser.role === 'admin' &&
      typeof req.query.employeeId === 'string' &&
      req.query.employeeId
    ) {
      employeeId = req.query.employeeId;
    }

    if (!employeeId) {
      sendProblem(res, 403, 'Sin perfil de empleado', 'El usuario no tiene empleado asociado.');
      return;
    }

    const emp = await repo.findEmployeeById(employeeId);
    if (!emp) {
      sendProblem(res, 404, 'Empleado no encontrado', 'No existe el empleado solicitado.');
      return;
    }

    const todayKey = getMadridDateKey(nowProvider().toISOString());
    const shifts = await gateway.getNextShifts(emp.id, emp.externalRef, todayKey, 7);
    res.json({ shifts, businessTimezone: 'Europe/Madrid' });
  });

  app.get('/api/v1/clock/shifts', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authUser = req.authUser!;
    const requestedEmpId =
      typeof req.query.employeeId === 'string' && req.query.employeeId.trim()
        ? req.query.employeeId.trim()
        : undefined;

    if (authUser.role !== 'admin' && requestedEmpId && requestedEmpId !== authUser.employeeId) {
      sendProblem(res, 403, 'Acceso denegado', 'No puedes consultar jornadas de otro empleado.');
      return;
    }

    const todayKey = getMadridDateKey(nowProvider().toISOString());
    const defaultFrom = getMondayOfWeek(todayKey);
    const defaultTo = addDaysToDateKey(defaultFrom, 6);
    const from =
      typeof req.query.from === 'string' && isValidDateKey(req.query.from)
        ? req.query.from
        : defaultFrom;
    const to =
      typeof req.query.to === 'string' && isValidDateKey(req.query.to) ? req.query.to : defaultTo;

    if (from > to) {
      sendProblem(res, 422, 'Rango no válido', 'La fecha inicial debe ser anterior o igual a la final.');
      return;
    }

    const targetEmployeeId = authUser.role === 'admin' ? requestedEmpId : authUser.employeeId ?? undefined;

    if (targetEmployeeId) {
      const emp = await repo.findEmployeeById(targetEmployeeId);
      if (!emp) {
        sendProblem(res, 404, 'Empleado no encontrado', 'No existe el empleado solicitado.');
        return;
      }
      const shifts = await gateway.getAssignments({
        employeeId: emp.id,
        employeeExternalRef: emp.externalRef,
        fromDateKey: from,
        toDateKey: to,
      });
      res.json({ shifts, from, to, businessTimezone: 'Europe/Madrid' });
      return;
    }

    const allEmployees = await repo.listEmployees(true);
    const merged: PlannedShift[] = [];
    for (const emp of allEmployees) {
      const list = await gateway.getAssignments({
        employeeId: emp.id,
        employeeExternalRef: emp.externalRef,
        fromDateKey: from,
        toDateKey: to,
      });
      merged.push(...list);
    }
    merged.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
    res.json({ shifts: merged, from, to, businessTimezone: 'Europe/Madrid' });
  });

  app.post(
    '/api/v1/clock/sessions/:id/acknowledge-overrun',
    requireAuth,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const session = await repo.findWorkSessionById(req.params.id);
      if (!session) {
        sendProblem(res, 404, 'Sesión no encontrada', 'La jornada indicada no existe.');
        return;
      }
      if (authUser.role !== 'admin' && session.employeeId !== authUser.employeeId) {
        sendProblem(res, 403, 'Acceso denegado', 'Solo puedes confirmar tu propia jornada.');
        return;
      }

      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (reason.length < 2) {
        sendProblem(
          res,
          422,
          'Motivo requerido',
          'Debes indicar el motivo para continuar trabajando fuera de tu hora prevista.',
        );
        return;
      }

      const nowIso = nowProvider().toISOString();
      const updated = await repo.acknowledgeSessionOverrun(session.id, reason, nowIso);
      if (!updated) {
        sendProblem(res, 404, 'Sesión no encontrada', 'No se pudo actualizar la jornada.');
        return;
      }

      await repo.appendAuditLog({
        id: crypto.randomUUID(),
        actorUserId: authUser.id,
        action: 'session.overrun_acknowledged',
        entityType: 'work_session',
        entityId: updated.id,
        details: {
          employeeId: updated.employeeId,
          reason,
          acknowledgedAt: nowIso,
        },
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
        createdAt: nowIso,
      });

      res.json({ session: updated });
    },
  );

  app.get('/api/v1/clock/sessions', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authUser = req.authUser!;
    let targetEmployeeId = authUser.employeeId ?? undefined;

    if (authUser.role === 'admin') {
      targetEmployeeId =
        typeof req.query.employeeId === 'string' && req.query.employeeId
          ? req.query.employeeId
          : undefined;
    } else if (
      typeof req.query.employeeId === 'string' &&
      req.query.employeeId &&
      req.query.employeeId !== authUser.employeeId
    ) {
      sendProblem(res, 403, 'Acceso denegado', 'No puedes consultar sesiones de otro empleado.');
      return;
    }

    if (targetEmployeeId) {
      await rebuildSessionsForEmployee(targetEmployeeId);
    } else if (authUser.role === 'admin') {
      const allEmps = await repo.listEmployees(true);
      for (const emp of allEmps) {
        await rebuildSessionsForEmployee(emp.id);
      }
    }

    const sessions = await repo.listWorkSessions(targetEmployeeId);
    res.json({
      sessions,
      anomalyConfig,
      lookbackDays: correctionLookbackDays,
    });
  });

  app.get('/api/v1/clock/corrections', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authUser = req.authUser!;
    const isAdmin = authUser.role === 'admin';

    const requestedEmpId =
      typeof req.query.employeeId === 'string' && req.query.employeeId
        ? req.query.employeeId
        : undefined;

    if (!isAdmin && requestedEmpId && requestedEmpId !== authUser.employeeId) {
      sendProblem(res, 403, 'Acceso denegado', 'Solo puedes consultar tus propias correcciones.');
      return;
    }

    const statusParam = req.query.status as CorrectionStatus | undefined;
    const kindParam = req.query.kind as CorrectionKind | undefined;

    const corrections = await repo.listCorrections({
      employeeId: isAdmin ? requestedEmpId : (authUser.employeeId ?? '__none__'),
      status:
        statusParam && ['pending', 'approved', 'rejected', 'cancelled'].includes(statusParam)
          ? statusParam
          : undefined,
      kind:
        kindParam && ['void_event', 'change_time', 'add_event', 'void_day'].includes(kindParam)
          ? kindParam
          : undefined,
      fromDate: typeof req.query.from === 'string' && req.query.from ? req.query.from : undefined,
      toDate: typeof req.query.to === 'string' && req.query.to ? req.query.to : undefined,
    });

    res.json({ corrections });
  });

  app.get('/api/v1/clock/corrections/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authUser = req.authUser!;
    const correction = await repo.findCorrectionById(req.params.id);
    if (!correction) {
      sendProblem(res, 404, 'No encontrado', 'La solicitud de corrección no existe.');
      return;
    }
    if (authUser.role !== 'admin' && correction.employeeId !== authUser.employeeId) {
      sendProblem(res, 403, 'Acceso denegado', 'No tienes permiso para ver esta solicitud.');
      return;
    }
    res.json({ correction });
  });

  app.post('/api/v1/clock/corrections', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authUser = req.authUser!;
    const isAdmin = authUser.role === 'admin';

    const idempotencyKeyHeader = req.headers['idempotency-key'];
    const idempotencyKey =
      typeof idempotencyKeyHeader === 'string' && idempotencyKeyHeader.trim()
        ? idempotencyKeyHeader.trim()
        : null;

    if (idempotencyKey) {
      const existing = await repo.findCorrectionByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (!isAdmin && existing.employeeId !== authUser.employeeId) {
          sendProblem(res, 403, 'Acceso denegado', 'Clave de idempotencia pertenece a otro empleado.');
          return;
        }
        res.status(200).json({ correction: existing, preview: existing.preview, deduplicated: true });
        return;
      }
    }

    const kind = req.body?.kind as CorrectionKind;
    if (!VALID_CORRECTION_KINDS.has(kind)) {
      sendProblem(
        res,
        422,
        'Tipo no válido',
        'El campo kind debe ser void_event, change_time, add_event o void_day.',
      );
      return;
    }

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 10) {
      sendProblem(
        res,
        422,
        'Motivo insuficiente',
        'El motivo es obligatorio y debe tener al menos 10 caracteres.',
      );
      return;
    }

    let targetEmployeeId = authUser.employeeId;
    if (typeof req.body?.employeeId === 'string' && req.body.employeeId.trim()) {
      if (!isAdmin && req.body.employeeId !== authUser.employeeId) {
        sendProblem(
          res,
          403,
          'Acceso denegado',
          'Un empleado no puede crear solicitudes para otro empleado.',
        );
        return;
      }
      targetEmployeeId = req.body.employeeId.trim();
    }

    const rawTargetEventId =
      typeof req.body?.targetEventId === 'string' && req.body.targetEventId.trim()
        ? req.body.targetEventId.trim()
        : null;
    const targetEventId = kind === 'add_event' || kind === 'void_day' ? null : rawTargetEventId;

    if (kind === 'void_event' || kind === 'change_time') {
      if (!targetEventId) {
        sendProblem(res, 422, 'Falta targetEventId', 'Debes indicar el fichaje que deseas corregir.');
        return;
      }
      const targetEv = await repo.findClockEventById(targetEventId);
      if (!targetEv) {
        sendProblem(res, 404, 'Fichaje no encontrado', 'El fichaje original indicado no existe.');
        return;
      }
      if (!isAdmin && targetEv.employeeId !== authUser.employeeId) {
        sendProblem(
          res,
          403,
          'Acceso denegado',
          'No puedes solicitar correcciones sobre fichajes de otro empleado.',
        );
        return;
      }
      targetEmployeeId = targetEv.employeeId;
    }

    if (!targetEmployeeId) {
      sendProblem(res, 422, 'Empleado requerido', 'No se pudo determinar el empleado afectado.');
      return;
    }

    const proposedRaw = (req.body?.proposedChange ?? {}) as ProposedCorrectionChange;
    const madridDateKey =
      typeof proposedRaw.madridDateKey === 'string' && proposedRaw.madridDateKey.trim()
        ? proposedRaw.madridDateKey.trim()
        : undefined;
    const proposedChange: ProposedCorrectionChange = {
      eventType: proposedRaw.eventType,
      declaredAtUtc:
        typeof proposedRaw.declaredAtUtc === 'string' && proposedRaw.declaredAtUtc.trim()
          ? new Date(proposedRaw.declaredAtUtc).toISOString()
          : undefined,
      breakTypeId: proposedRaw.breakTypeId ?? null,
      facilityRef: proposedRaw.facilityRef ?? null,
      assignmentRef: proposedRaw.assignmentRef ?? null,
      projectRef: proposedRaw.projectRef ?? null,
      madridDateKey,
    };

    const nowMs = nowProvider().getTime();
    const lookbackCutoffMs = nowMs - correctionLookbackDays * 24 * 60 * 60 * 1000;

    if (kind === 'change_time' || kind === 'add_event') {
      if (!proposedChange.declaredAtUtc || Number.isNaN(Date.parse(proposedChange.declaredAtUtc))) {
        sendProblem(res, 422, 'Fecha no válida', 'Debes indicar una fecha y hora válidas.');
        return;
      }
      const proposedMs = Date.parse(proposedChange.declaredAtUtc);
      if (proposedMs > nowMs + 60_000) {
        sendProblem(
          res,
          422,
          'Hora futura no permitida',
          'La hora propuesta no puede estar en el futuro.',
        );
        return;
      }
      if (proposedMs < lookbackCutoffMs) {
        sendProblem(
          res,
          422,
          'Fuera de plazo',
          `Solo se pueden solicitar correcciones dentro de los últimos ${correctionLookbackDays} días.`,
        );
        return;
      }
    }

    if (kind === 'void_day') {
      if (!madridDateKey || !isValidDateKey(madridDateKey)) {
        sendProblem(
          res,
          422,
          'Fecha no válida',
          'Debes indicar la fecha (YYYY-MM-DD) de la jornada a anular.',
        );
        return;
      }
      const existingPendingDayVoids = await repo.listCorrections({
        employeeId: targetEmployeeId,
        status: 'pending',
        kind: 'void_day',
      });
      if (existingPendingDayVoids.some((c) => c.proposedChange.madridDateKey === madridDateKey)) {
        sendProblem(
          res,
          409,
          'Solicitud duplicada',
          'Ya existe una solicitud pendiente para anular esta jornada completa.',
        );
        return;
      }
    }

    if (targetEventId) {
      const targetEv = await repo.findClockEventById(targetEventId);
      if (targetEv && Date.parse(targetEv.deviceDeclaredAt) < lookbackCutoffMs) {
        sendProblem(
          res,
          422,
          'Fuera de plazo',
          `El fichaje original supera el plazo máximo de ${correctionLookbackDays} días.`,
        );
        return;
      }
    }

    const [existingEvents, breakTypes] = await Promise.all([
      repo.listClockEvents({ employeeId: targetEmployeeId }),
      repo.listBreakTypes(false),
    ]);

    const sim = simulateCorrectionAndPreview({
      existingEvents,
      breakTypes,
      kind,
      targetEventId,
      proposedChange,
      employeeId: targetEmployeeId,
      nowMs,
    });

    if (!sim.ok) {
      sendProblem(res, sim.status, 'Secuencia inválida', sim.reason);
      return;
    }

    if (kind === 'void_day' && sim.voidDayEvents && sim.voidDayEvents.length > 0) {
      const latestEv = sim.voidDayEvents[sim.voidDayEvents.length - 1];
      if (Date.parse(latestEv.deviceDeclaredAt) < lookbackCutoffMs) {
        sendProblem(
          res,
          422,
          'Fuera de plazo',
          `La jornada seleccionada supera el plazo máximo de ${correctionLookbackDays} días.`,
        );
        return;
      }
      proposedChange.voidedEventIds = sim.voidDayEvents.map((e) => e.id);
      proposedChange.voidedEventSummaries = sim.voidDayEvents.map((e) => ({
        id: e.id,
        type: e.type,
        deviceDeclaredAt: e.deviceDeclaredAt,
      }));
    }

    const createdAt = new Date(nowMs).toISOString();
    const correctionId = crypto.randomUUID();
    const { correction, deduplicated } = await repo.createCorrection({
      id: correctionId,
      employeeId: targetEmployeeId,
      targetEventId,
      kind,
      requestedBy: authUser.id,
      reason,
      proposedChange,
      preview: sim.preview,
      idempotencyKey,
      createdAt,
    });

    if (!deduplicated) {
      const isCreatedByAdminForEmployee = isAdmin && targetEmployeeId !== authUser.employeeId;
      await repo.appendAuditLog({
        id: crypto.randomUUID(),
        actorUserId: authUser.id,
        action: isCreatedByAdminForEmployee ? 'correction.admin_created' : 'correction.requested',
        entityType: 'correction',
        entityId: correction.id,
        details: {
          employeeId: targetEmployeeId,
          kind,
          targetEventId,
          reason,
          proposedChange,
          preview: sim.preview,
        },
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
        createdAt,
      });
      await rebuildSessionsForEmployee(targetEmployeeId);
    }

    res.status(deduplicated ? 200 : 201).json({
      correction,
      preview: correction.preview,
      deduplicated,
    });
  });

  app.post('/api/v1/clock/corrections/:id/cancel', requireAuth, async (req: AuthenticatedRequest, res) => {
    const authUser = req.authUser!;
    const existing = await repo.findCorrectionById(req.params.id);
    if (!existing) {
      sendProblem(res, 404, 'No encontrado', 'La corrección no existe.');
      return;
    }
    if (existing.requestedBy !== authUser.id) {
      sendProblem(res, 403, 'Acceso denegado', 'Solo el autor de la solicitud puede cancelarla.');
      return;
    }
    if (existing.status !== 'pending') {
      sendProblem(res, 409, 'Estado no válido', 'Solo se pueden cancelar solicitudes pendientes.');
      return;
    }

    const nowIso = nowProvider().toISOString();
    const cancelled = await repo.cancelCorrection(existing.id, nowIso);
    if (!cancelled) {
      sendProblem(res, 409, 'Conflicto de estado', 'La solicitud ya fue resuelta.');
      return;
    }

    await repo.appendAuditLog({
      id: crypto.randomUUID(),
      actorUserId: authUser.id,
      action: 'correction.cancelled',
      entityType: 'correction',
      entityId: cancelled.id,
      details: { employeeId: cancelled.employeeId, kind: cancelled.kind },
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
      createdAt: nowIso,
    });

    await rebuildSessionsForEmployee(cancelled.employeeId);
    res.json({ correction: cancelled });
  });

  app.post(
    '/api/v1/clock/corrections/:id/reject',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const existing = await repo.findCorrectionById(req.params.id);
      if (!existing) {
        sendProblem(res, 404, 'No encontrado', 'La corrección no existe.');
        return;
      }
      if (existing.requestedBy === authUser.id) {
        sendProblem(
          res,
          403,
          'Auto-resolución prohibida',
          'Un administrador no puede resolver sus propias solicitudes.',
        );
        return;
      }
      if (existing.status !== 'pending') {
        sendProblem(res, 409, 'Ya resuelta', 'Esta solicitud de corrección ya fue resuelta.');
        return;
      }

      const note = typeof req.body?.resolutionNote === 'string' ? req.body.resolutionNote.trim() : '';
      if (!note) {
        sendProblem(
          res,
          422,
          'Nota obligatoria',
          'Debes indicar el motivo del rechazo en resolutionNote.',
        );
        return;
      }

      const nowIso = nowProvider().toISOString();
      const rejected = await repo.rejectCorrection(existing.id, authUser.id, note, nowIso);
      if (!rejected) {
        sendProblem(res, 409, 'Conflicto de estado', 'La solicitud ya fue resuelta.');
        return;
      }

      await repo.appendAuditLog({
        id: crypto.randomUUID(),
        actorUserId: authUser.id,
        action: 'correction.rejected',
        entityType: 'correction',
        entityId: rejected.id,
        details: {
          employeeId: rejected.employeeId,
          kind: rejected.kind,
          resolutionNote: note,
        },
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
        createdAt: nowIso,
      });

      await rebuildSessionsForEmployee(rejected.employeeId);
      res.json({ correction: rejected });
    },
  );

  app.post(
    '/api/v1/clock/corrections/:id/approve',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const existing = await repo.findCorrectionById(req.params.id);
      if (!existing) {
        sendProblem(res, 404, 'No encontrado', 'La corrección no existe.');
        return;
      }
      if (existing.requestedBy === authUser.id) {
        sendProblem(
          res,
          403,
          'Auto-aprobación prohibida',
          'Un administrador no puede aprobar sus propias solicitudes; debe hacerlo otro administrador.',
        );
        return;
      }

      const idempotencyKeyHeader = req.headers['idempotency-key'];
      const approvalIdempotencyKey =
        typeof idempotencyKeyHeader === 'string' && idempotencyKeyHeader.trim()
          ? idempotencyKeyHeader.trim()
          : null;

      if (existing.status !== 'pending') {
        if (
          existing.status === 'approved' &&
          approvalIdempotencyKey &&
          req.headers['idempotency-key']
        ) {
          // Dejamos que approveCorrectionAtomic verifique approval_idempotency_key
        } else {
          sendProblem(res, 409, 'Ya resuelta', 'Esta solicitud de corrección ya fue resuelta.');
          return;
        }
      }

      const now = nowProvider();
      const nowIso = now.toISOString();
      const nowMs = now.getTime();
      const note =
        typeof req.body?.resolutionNote === 'string' && req.body.resolutionNote.trim()
          ? req.body.resolutionNote.trim()
          : null;

      const [emp, currentEvents, breakTypes] = await Promise.all([
        repo.findEmployeeById(existing.employeeId),
        repo.listClockEvents({ employeeId: existing.employeeId }),
        repo.listBreakTypes(false),
      ]);

      if (!emp) {
        sendProblem(res, 404, 'Empleado no encontrado', 'El empleado asociado no existe.');
        return;
      }

      let compensatingEvents: InsertClockEventInput[] = [];
      let rootSessionId: string | null = null;
      const allById = new Map(currentEvents.map((e) => [e.id, e]));

      if (existing.status === 'pending') {
        const sim = simulateCorrectionAndPreview({
          existingEvents: currentEvents,
          breakTypes,
          kind: existing.kind,
          targetEventId: existing.targetEventId,
          proposedChange: existing.proposedChange,
          employeeId: existing.employeeId,
          nowMs,
        });

        if (!sim.ok) {
          if (existing.kind === 'void_day') {
            sendProblem(
              res,
              409,
              'Jornada ya anulada',
              'Los fichajes de esa jornada ya han sido anulados.',
            );
            return;
          }
          sendProblem(res, sim.status, 'Secuencia inválida', sim.reason);
          return;
        }

        const targetEv = existing.targetEventId ? allById.get(existing.targetEventId) ?? null : null;
        if (targetEv) {
          const shifts = buildShiftsFromEvents(currentEvents, breakTypes, nowMs);
          const matchingShift = shifts.find((s) => s.events.some((e) => e.id === targetEv.id));
          rootSessionId = matchingShift ? matchingShift.id : resolveRootEventId(targetEv, allById);
        }

        if (existing.kind === 'void_day') {
          const dayKey = existing.proposedChange.madridDateKey ?? '';
          const dayEvents = getEventsForDayVoid(currentEvents, dayKey, breakTypes, nowMs);
          if (dayEvents.length === 0) {
            sendProblem(
              res,
              409,
              'Jornada ya anulada',
              'Los fichajes de esa jornada ya han sido anulados.',
            );
            return;
          }
          const shifts = buildShiftsFromEvents(currentEvents, breakTypes, nowMs);
          const matchingShift = shifts.find((s) => s.madridDateKey === dayKey);
          rootSessionId = matchingShift ? matchingShift.id : resolveRootEventId(dayEvents[0], allById);
          compensatingEvents = dayEvents.map((ev) => ({
            id: crypto.randomUUID(),
            employeeId: existing.employeeId,
            type: 'event_void' as const,
            breakTypeId: null,
            receivedAt: nowIso,
            deviceDeclaredAt: ev.deviceDeclaredAt,
            deviceOffsetMs: ev.deviceOffsetMs,
            timeSource: 'device_declared' as const,
            source: 'admin' as const,
            correctsEventId: ev.id,
            correctionId: existing.id,
            assignmentRef: ev.assignmentRef,
            projectRef: ev.projectRef,
            facilityRef: ev.facilityRef,
          }));
        } else if (existing.kind === 'void_event' && targetEv) {
          compensatingEvents = [
            {
              id: crypto.randomUUID(),
              employeeId: existing.employeeId,
              type: 'event_void',
              breakTypeId: null,
              receivedAt: nowIso,
              deviceDeclaredAt: targetEv.deviceDeclaredAt,
              deviceOffsetMs: targetEv.deviceOffsetMs,
              timeSource: 'device_declared',
              source: 'admin',
              correctsEventId: targetEv.id,
              correctionId: existing.id,
              assignmentRef: targetEv.assignmentRef,
              projectRef: targetEv.projectRef,
              facilityRef: targetEv.facilityRef,
            },
          ];
        } else if (existing.kind === 'change_time' && targetEv) {
          const newUtc = existing.proposedChange.declaredAtUtc!;
          compensatingEvents = [
            {
              id: crypto.randomUUID(),
              employeeId: existing.employeeId,
              type: 'event_void',
              breakTypeId: null,
              receivedAt: nowIso,
              deviceDeclaredAt: targetEv.deviceDeclaredAt,
              deviceOffsetMs: targetEv.deviceOffsetMs,
              timeSource: 'device_declared',
              source: 'admin',
              correctsEventId: targetEv.id,
              correctionId: existing.id,
              assignmentRef: targetEv.assignmentRef,
              projectRef: targetEv.projectRef,
              facilityRef: targetEv.facilityRef,
            },
            {
              id: crypto.randomUUID(),
              employeeId: existing.employeeId,
              type: targetEv.type,
              breakTypeId: targetEv.breakTypeId,
              receivedAt: nowIso,
              deviceDeclaredAt: newUtc,
              deviceOffsetMs: targetEv.deviceOffsetMs,
              timeSource: 'device_declared',
              source: 'admin',
              correctsEventId: targetEv.id,
              correctionId: existing.id,
              assignmentRef: targetEv.assignmentRef,
              projectRef: targetEv.projectRef,
              facilityRef: targetEv.facilityRef,
            },
          ];
        } else if (existing.kind === 'add_event') {
          const newUtc = existing.proposedChange.declaredAtUtc!;
          const evType = existing.proposedChange.eventType!;
          compensatingEvents = [
            {
              id: crypto.randomUUID(),
              employeeId: existing.employeeId,
              type: evType,
              breakTypeId: existing.proposedChange.breakTypeId ?? null,
              receivedAt: nowIso,
              deviceDeclaredAt: newUtc,
              deviceOffsetMs: 0,
              timeSource: 'device_declared',
              source: 'admin',
              correctsEventId: null,
              correctionId: existing.id,
              assignmentRef: existing.proposedChange.assignmentRef ?? null,
              projectRef: existing.proposedChange.projectRef ?? null,
              facilityRef: existing.proposedChange.facilityRef ?? null,
            },
          ];
        }
      }

      const todayKey = getMadridDateKey(nowIso);
      const [plannedShifts, allCorrections, policy] = await Promise.all([
        gateway.getAssignments({
          employeeId: emp.id,
          employeeExternalRef: emp.externalRef,
          fromDateKey: addDaysToDateKey(todayKey, -14),
          toDateKey: addDaysToDateKey(todayKey, 7),
        }),
        repo.listCorrections({ employeeId: emp.id }),
        repo.getClockPolicy(),
      ]);

      let result;
      try {
        result = await repo.approveCorrectionAtomic({
          correctionId: existing.id,
          resolvedByUserId: authUser.id,
          resolvedByEmail: authUser.email,
          resolvedAtUtc: nowIso,
          resolutionNote: note,
          approvalIdempotencyKey,
          compensatingEvents,
          recomputeSessions: (eventsAfterApproval, existingSessionsById) =>
            buildWorkSessionsProjection({
              employeeId: emp.id,
              events: eventsAfterApproval,
              breakTypes,
              plannedShifts,
              corrections: allCorrections.map((c) =>
                c.id === existing.id ? { ...c, status: 'approved' as const } : c,
              ),
              config: anomalyConfig,
              policy,
              existingSessionsById,
              nowMs,
            }),
          buildOutboxPayload: (insertedEvents, recalculatedSession) => ({
            correctionId: existing.id,
            sessionId: recalculatedSession?.id ?? rootSessionId,
            employeeId: emp.id,
            employeeExternalRef: emp.externalRef,
            employeeName: emp.name,
            correctionKind: existing.kind,
            reason: existing.reason,
            originalEvent: existing.targetEvent ?? null,
            compensatingEvents: insertedEvents,
            approvedBy: {
              userId: authUser.id,
              email: authUser.email,
            },
            approvedAtUtc: nowIso,
            recalculatedSession,
          }),
        });
      } catch (err) {
        if (err instanceof Error && err.message === 'CORRECTION_ALREADY_RESOLVED') {
          sendProblem(res, 409, 'Ya resuelta', 'Esta solicitud de corrección ya fue resuelta.');
          return;
        }
        throw err;
      }

      if (!result.deduplicated) {
        await repo.appendAuditLog({
          id: crypto.randomUUID(),
          actorUserId: authUser.id,
          action: 'correction.approved',
          entityType: 'correction',
          entityId: result.correction.id,
          details: {
            employeeId: result.correction.employeeId,
            kind: result.correction.kind,
            targetEventId: result.correction.targetEventId,
            insertedEventIds: result.insertedEvents.map((e) => e.id),
            resolutionNote: note,
          },
          ipAddress: getClientIp(req),
          userAgent: getUserAgent(req),
          createdAt: nowIso,
        });

        await rebuildSessionsForEmployee(emp.id);
        await flushCorrectionOutbox(authUser.id, getClientIp(req), getUserAgent(req));
      }

      res.json({
        correction: result.correction,
        compensatingEvents: result.insertedEvents,
        deduplicated: result.deduplicated,
      });
    },
  );

  // =========================================================================
  // API v1 ADMIN: PLANIFICACIÓN DE JORNADAS, PLANTILLAS, DÍAS LIBRES,
  // POLÍTICAS, VIGILANCIA DE RELOJES Y RESUMEN DIARIO
  // =========================================================================

  app.get('/api/v1/admin/shifts', requireAuth, requireAdmin, async (req, res) => {
    const employeeId =
      typeof req.query.employeeId === 'string' && req.query.employeeId.trim()
        ? req.query.employeeId.trim()
        : undefined;
    const fromDate =
      typeof req.query.from === 'string' && isValidDateKey(req.query.from)
        ? req.query.from
        : undefined;
    const toDate =
      typeof req.query.to === 'string' && isValidDateKey(req.query.to) ? req.query.to : undefined;

    const shifts = await repo.listPlannedShifts({ employeeId, fromDate, toDate });
    res.json({ shifts });
  });

  app.post(
    '/api/v1/admin/shifts',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const employeeId =
        typeof req.body?.employeeId === 'string' ? req.body.employeeId.trim() : '';
      const madridDateKey =
        typeof req.body?.madridDateKey === 'string' ? req.body.madridDateKey.trim() : '';
      const startTimeMadrid =
        typeof req.body?.startTimeMadrid === 'string' ? req.body.startTimeMadrid.trim() : '';
      const endTimeMadrid =
        typeof req.body?.endTimeMadrid === 'string' ? req.body.endTimeMadrid.trim() : '';
      const crossesMidnight = Boolean(req.body?.crossesMidnight);
      const plannedBreakMinutes = Number(req.body?.plannedBreakMinutes ?? 0);
      const projectRef =
        typeof req.body?.projectRef === 'string' && req.body.projectRef.trim()
          ? req.body.projectRef.trim()
          : null;
      const facilityRef =
        typeof req.body?.facilityRef === 'string' && req.body.facilityRef.trim()
          ? req.body.facilityRef.trim()
          : null;
      const assignmentRef =
        typeof req.body?.assignmentRef === 'string' && req.body.assignmentRef.trim()
          ? req.body.assignmentRef.trim()
          : null;

      if (!employeeId) {
        sendProblem(res, 422, 'Empleado obligatorio', 'Debes seleccionar un empleado.');
        return;
      }
      const emp = await repo.findEmployeeById(employeeId);
      if (!emp) {
        sendProblem(res, 404, 'Empleado no encontrado', 'El empleado indicado no existe.');
        return;
      }

      const bounds = computePlannedShiftBounds({
        madridDateKey,
        startTimeMadrid,
        endTimeMadrid,
        crossesMidnight,
        plannedBreakMinutes,
      });
      if (!bounds.ok) {
        sendProblem(res, bounds.status, 'Jornada no válida', bounds.reason);
        return;
      }

      const nearby = await repo.listPlannedShifts({
        employeeId,
        fromDate: addDaysToDateKey(madridDateKey, -1),
        toDate: addDaysToDateKey(madridDateKey, 1),
      });
      const overlap = validateNoShiftOverlap(
        { employeeId, startUtc: bounds.startUtc, endUtc: bounds.endUtc },
        nearby,
      );
      if (!overlap.ok) {
        sendProblem(res, overlap.status, 'Solapamiento de jornadas', overlap.reason);
        return;
      }

      const nowIso = nowProvider().toISOString();
      const created = await repo.createPlannedShift({
        id: crypto.randomUUID(),
        employeeId,
        madridDateKey: bounds.madridDateKey,
        startUtc: bounds.startUtc,
        endUtc: bounds.endUtc,
        plannedBreakMinutes: bounds.plannedBreakMinutes,
        plannedMinutes: bounds.plannedMinutes,
        projectRef,
        facilityRef,
        assignmentRef,
        source: 'local',
        templateId: null,
        label: bounds.label,
        createdAt: nowIso,
      });

      await repo.appendAuditLog({
        id: crypto.randomUUID(),
        actorUserId: authUser.id,
        action: 'planned_shift.created',
        entityType: 'planned_shift',
        entityId: created.id,
        details: {
          employeeId: created.employeeId,
          after: created,
        },
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
        createdAt: nowIso,
      });

      await rebuildSessionsForEmployee(employeeId);
      res.status(201).json({ shift: created });
    },
  );

  app.put(
    '/api/v1/admin/shifts/:id',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const existing = await repo.findPlannedShiftById(req.params.id);
      if (!existing) {
        sendProblem(res, 404, 'Jornada no encontrada', 'La jornada planificada no existe.');
        return;
      }

      const madridDateKey =
        typeof req.body?.madridDateKey === 'string' && req.body.madridDateKey.trim()
          ? req.body.madridDateKey.trim()
          : existing.madridDateKey;
      const startTimeMadrid =
        typeof req.body?.startTimeMadrid === 'string' && req.body.startTimeMadrid.trim()
          ? req.body.startTimeMadrid.trim()
          : formatMadridTime(existing.startUtc);
      const endTimeMadrid =
        typeof req.body?.endTimeMadrid === 'string' && req.body.endTimeMadrid.trim()
          ? req.body.endTimeMadrid.trim()
          : formatMadridTime(existing.endUtc);
      const crossesMidnight =
        typeof req.body?.crossesMidnight === 'boolean'
          ? req.body.crossesMidnight
          : getMadridDateKey(existing.endUtc) !== existing.madridDateKey;
      const plannedBreakMinutes =
        req.body?.plannedBreakMinutes !== undefined
          ? Number(req.body.plannedBreakMinutes)
          : existing.plannedBreakMinutes;

      const projectRef =
        req.body?.projectRef === null
          ? null
          : typeof req.body?.projectRef === 'string'
            ? req.body.projectRef.trim() || null
            : existing.projectRef;
      const facilityRef =
        req.body?.facilityRef === null
          ? null
          : typeof req.body?.facilityRef === 'string'
            ? req.body.facilityRef.trim() || null
            : existing.facilityRef;
      const assignmentRef =
        req.body?.assignmentRef === null
          ? null
          : typeof req.body?.assignmentRef === 'string'
            ? req.body.assignmentRef.trim() || null
            : existing.assignmentRef;

      const bounds = computePlannedShiftBounds({
        madridDateKey,
        startTimeMadrid,
        endTimeMadrid,
        crossesMidnight,
        plannedBreakMinutes,
      });
      if (!bounds.ok) {
        sendProblem(res, bounds.status, 'Jornada no válida', bounds.reason);
        return;
      }

      const nearby = await repo.listPlannedShifts({
        employeeId: existing.employeeId,
        fromDate: addDaysToDateKey(madridDateKey, -1),
        toDate: addDaysToDateKey(madridDateKey, 1),
      });
      const overlap = validateNoShiftOverlap(
        {
          id: existing.id,
          employeeId: existing.employeeId,
          startUtc: bounds.startUtc,
          endUtc: bounds.endUtc,
        },
        nearby,
      );
      if (!overlap.ok) {
        sendProblem(res, overlap.status, 'Solapamiento de jornadas', overlap.reason);
        return;
      }

      const nowIso = nowProvider().toISOString();
      const updated = await repo.updatePlannedShift(existing.id, {
        madridDateKey: bounds.madridDateKey,
        startUtc: bounds.startUtc,
        endUtc: bounds.endUtc,
        plannedBreakMinutes: bounds.plannedBreakMinutes,
        plannedMinutes: bounds.plannedMinutes,
        projectRef,
        facilityRef,
        assignmentRef,
        label: bounds.label,
        updatedAt: nowIso,
      });

      if (!updated) {
        sendProblem(res, 404, 'Jornada no encontrada', 'No se pudo actualizar la jornada.');
        return;
      }

      await repo.appendAuditLog({
        id: crypto.randomUUID(),
        actorUserId: authUser.id,
        action: 'planned_shift.updated',
        entityType: 'planned_shift',
        entityId: updated.id,
        details: {
          employeeId: updated.employeeId,
          before: existing,
          after: updated,
        },
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
        createdAt: nowIso,
      });

      await rebuildSessionsForEmployee(updated.employeeId);
      res.json({ shift: updated });
    },
  );

  app.delete(
    '/api/v1/admin/shifts/:id',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const existing = await repo.findPlannedShiftById(req.params.id);
      if (!existing) {
        sendProblem(res, 404, 'Jornada no encontrada', 'La jornada planificada no existe.');
        return;
      }

      await repo.deletePlannedShift(existing.id);
      const nowIso = nowProvider().toISOString();

      await repo.appendAuditLog({
        id: crypto.randomUUID(),
        actorUserId: authUser.id,
        action: 'planned_shift.deleted',
        entityType: 'planned_shift',
        entityId: existing.id,
        details: {
          employeeId: existing.employeeId,
          before: existing,
        },
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
        createdAt: nowIso,
      });

      await rebuildSessionsForEmployee(existing.employeeId);
      res.json({ ok: true });
    },
  );

  app.post(
    '/api/v1/admin/shifts/generate',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const templateId =
        typeof req.body?.templateId === 'string' ? req.body.templateId.trim() : '';
      const from = typeof req.body?.from === 'string' ? req.body.from.trim() : '';
      const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';

      if (!templateId || !isValidDateKey(from) || !isValidDateKey(to) || from > to) {
        sendProblem(
          res,
          422,
          'Parámetros no válidos',
          'Debes indicar templateId y un rango válido de fechas (from <= to).',
        );
        return;
      }

      const template = await repo.findShiftTemplateById(templateId);
      if (!template) {
        sendProblem(res, 404, 'Plantilla no encontrada', 'La plantilla indicada no existe.');
        return;
      }

      const [existingShifts, dayOffs] = await Promise.all([
        repo.listPlannedShifts({
          employeeId: template.employeeId,
          fromDate: addDaysToDateKey(from, -1),
          toDate: addDaysToDateKey(to, 1),
        }),
        repo.listDayOffs({ fromDate: from, toDate: to }),
      ]);

      const { toCreate, skippedDates } = expandTemplateInRange({
        template,
        fromDateKey: from,
        toDateKey: to,
        existingShifts,
        dayOffs,
      });

      const nowIso = nowProvider().toISOString();
      const created: PlannedShift[] = [];

      for (const item of toCreate) {
        const shift = await repo.createPlannedShift({
          id: crypto.randomUUID(),
          employeeId: template.employeeId,
          madridDateKey: item.madridDateKey,
          startUtc: item.startUtc,
          endUtc: item.endUtc,
          plannedBreakMinutes: item.plannedBreakMinutes,
          plannedMinutes: item.plannedMinutes,
          projectRef: item.projectRef,
          facilityRef: item.facilityRef,
          assignmentRef: null,
          source: 'local',
          templateId: template.id,
          label: item.label,
          createdAt: nowIso,
        });
        created.push(shift);

        await repo.appendAuditLog({
          id: crypto.randomUUID(),
          actorUserId: authUser.id,
          action: 'planned_shift.created',
          entityType: 'planned_shift',
          entityId: shift.id,
          details: {
            employeeId: shift.employeeId,
            generatedFromTemplateId: template.id,
            after: shift,
          },
          ipAddress: getClientIp(req),
          userAgent: getUserAgent(req),
          createdAt: nowIso,
        });
      }

      await rebuildSessionsForEmployee(template.employeeId);
      res.status(201).json({
        createdCount: created.length,
        skippedCount: skippedDates.length,
        skippedDates,
        shifts: created,
      });
    },
  );

  app.post(
    '/api/v1/admin/shifts/copy-week',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const sourceMonday =
        typeof req.body?.sourceMonday === 'string' ? req.body.sourceMonday.trim() : '';
      const targetMonday =
        typeof req.body?.targetMonday === 'string' ? req.body.targetMonday.trim() : '';
      const employeeId =
        typeof req.body?.employeeId === 'string' && req.body.employeeId.trim()
          ? req.body.employeeId.trim()
          : undefined;

      if (!isValidDateKey(sourceMonday) || !isValidDateKey(targetMonday)) {
        sendProblem(res, 422, 'Fechas no válidas', 'Debes indicar sourceMonday y targetMonday.');
        return;
      }

      const sourceEnd = addDaysToDateKey(sourceMonday, 6);
      const targetEnd = addDaysToDateKey(targetMonday, 6);
      const deltaDays = Math.round(
        (Date.parse(`${targetMonday}T00:00:00.000Z`) -
          Date.parse(`${sourceMonday}T00:00:00.000Z`)) /
          86_400_000,
      );

      const [sourceShifts, targetExisting, dayOffs] = await Promise.all([
        repo.listPlannedShifts({ employeeId, fromDate: sourceMonday, toDate: sourceEnd }),
        repo.listPlannedShifts({
          employeeId,
          fromDate: addDaysToDateKey(targetMonday, -1),
          toDate: addDaysToDateKey(targetEnd, 1),
        }),
        repo.listDayOffs({ fromDate: targetMonday, toDate: targetEnd }),
      ]);

      const nowIso = nowProvider().toISOString();
      const created: PlannedShift[] = [];
      let skippedCount = 0;

      for (const src of sourceShifts) {
        const targetDateKey = addDaysToDateKey(src.madridDateKey, deltaDays);
        const isDayOff = dayOffs.some(
          (d) =>
            d.madridDate === targetDateKey &&
            (d.employeeId === null || d.employeeId === src.employeeId),
        );
        const alreadyOnDay = [...targetExisting, ...created].some(
          (s) => s.employeeId === src.employeeId && s.madridDateKey === targetDateKey,
        );
        if (isDayOff || alreadyOnDay) {
          skippedCount += 1;
          continue;
        }

        const startHm = formatMadridTime(src.startUtc);
        const endHm = formatMadridTime(src.endUtc);
        const crossesMidnight = getMadridDateKey(src.endUtc) !== src.madridDateKey;

        const bounds = computePlannedShiftBounds({
          madridDateKey: targetDateKey,
          startTimeMadrid: startHm,
          endTimeMadrid: endHm,
          crossesMidnight,
          plannedBreakMinutes: src.plannedBreakMinutes,
        });
        if (!bounds.ok) {
          skippedCount += 1;
          continue;
        }

        const overlap = validateNoShiftOverlap(
          { employeeId: src.employeeId, startUtc: bounds.startUtc, endUtc: bounds.endUtc },
          [...targetExisting, ...created],
        );
        if (!overlap.ok) {
          skippedCount += 1;
          continue;
        }

        const shift = await repo.createPlannedShift({
          id: crypto.randomUUID(),
          employeeId: src.employeeId,
          madridDateKey: bounds.madridDateKey,
          startUtc: bounds.startUtc,
          endUtc: bounds.endUtc,
          plannedBreakMinutes: bounds.plannedBreakMinutes,
          plannedMinutes: bounds.plannedMinutes,
          projectRef: src.projectRef,
          facilityRef: src.facilityRef,
          assignmentRef: src.assignmentRef,
          source: 'local',
          templateId: src.templateId ?? null,
          label: bounds.label,
          createdAt: nowIso,
        });
        created.push(shift);

        await repo.appendAuditLog({
          id: crypto.randomUUID(),
          actorUserId: authUser.id,
          action: 'planned_shift.created',
          entityType: 'planned_shift',
          entityId: shift.id,
          details: {
            employeeId: shift.employeeId,
            copiedFromShiftId: src.id,
            after: shift,
          },
          ipAddress: getClientIp(req),
          userAgent: getUserAgent(req),
          createdAt: nowIso,
        });
      }

      res.status(201).json({
        createdCount: created.length,
        skippedCount,
        shifts: created,
      });
    },
  );

  app.get('/api/v1/admin/shift-templates', requireAuth, requireAdmin, async (req, res) => {
    const employeeId =
      typeof req.query.employeeId === 'string' && req.query.employeeId.trim()
        ? req.query.employeeId.trim()
        : undefined;
    const templates = await repo.listShiftTemplates(employeeId);
    res.json({ templates });
  });

  app.post(
    '/api/v1/admin/shift-templates',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const employeeId =
        typeof req.body?.employeeId === 'string' ? req.body.employeeId.trim() : '';
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const weekdays: number[] = Array.isArray(req.body?.weekdays)
        ? Array.from(
            new Set<number>(
              (req.body.weekdays as unknown[])
                .map((v) => Number(v))
                .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7),
            ),
          ).sort((a, b) => a - b)
        : [];
      const startTimeMadrid =
        typeof req.body?.startTimeMadrid === 'string' ? req.body.startTimeMadrid.trim() : '';
      const endTimeMadrid =
        typeof req.body?.endTimeMadrid === 'string' ? req.body.endTimeMadrid.trim() : '';
      const crossesMidnight = Boolean(req.body?.crossesMidnight);
      const plannedBreakMinutes = Number(req.body?.plannedBreakMinutes ?? 0);
      const validFrom = typeof req.body?.validFrom === 'string' ? req.body.validFrom.trim() : '';
      const validTo =
        typeof req.body?.validTo === 'string' && req.body.validTo.trim()
          ? req.body.validTo.trim()
          : null;
      const projectRef =
        typeof req.body?.projectRef === 'string' && req.body.projectRef.trim()
          ? req.body.projectRef.trim()
          : null;
      const facilityRef =
        typeof req.body?.facilityRef === 'string' && req.body.facilityRef.trim()
          ? req.body.facilityRef.trim()
          : null;

      if (!employeeId || !name || weekdays.length === 0 || !isValidDateKey(validFrom)) {
        sendProblem(
          res,
          422,
          'Plantilla incompleta',
          'Empleado, nombre, días de semana y fecha de vigencia inicial son obligatorios.',
        );
        return;
      }
      if (validTo && (!isValidDateKey(validTo) || validTo < validFrom)) {
        sendProblem(res, 422, 'Vigencia no válida', 'validTo debe ser posterior o igual a validFrom.');
        return;
      }

      const emp = await repo.findEmployeeById(employeeId);
      if (!emp) {
        sendProblem(res, 404, 'Empleado no encontrado', 'El empleado indicado no existe.');
        return;
      }

      const boundsCheck = computePlannedShiftBounds({
        madridDateKey: validFrom,
        startTimeMadrid,
        endTimeMadrid,
        crossesMidnight,
        plannedBreakMinutes,
      });
      if (!boundsCheck.ok) {
        sendProblem(res, boundsCheck.status, 'Horario de plantilla no válido', boundsCheck.reason);
        return;
      }

      const nowIso = nowProvider().toISOString();
      const template = await repo.createShiftTemplate({
        id: crypto.randomUUID(),
        employeeId,
        name,
        weekdays,
        startTimeMadrid,
        endTimeMadrid,
        crossesMidnight,
        plannedBreakMinutes: boundsCheck.plannedBreakMinutes,
        projectRef,
        facilityRef,
        validFrom,
        validTo,
        isActive: req.body?.isActive !== false,
        createdAt: nowIso,
      });

      await repo.appendAuditLog({
        id: crypto.randomUUID(),
        actorUserId: authUser.id,
        action: 'shift_template.created',
        entityType: 'shift_template',
        entityId: template.id,
        details: { employeeId: template.employeeId, after: template },
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
        createdAt: nowIso,
      });

      res.status(201).json({ template });
    },
  );

  app.put(
    '/api/v1/admin/shift-templates/:id',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const existing = await repo.findShiftTemplateById(req.params.id);
      if (!existing) {
        sendProblem(res, 404, 'Plantilla no encontrada', 'La plantilla indicada no existe.');
        return;
      }

      const startTimeMadrid =
        typeof req.body?.startTimeMadrid === 'string'
          ? req.body.startTimeMadrid.trim()
          : existing.startTimeMadrid;
      const endTimeMadrid =
        typeof req.body?.endTimeMadrid === 'string'
          ? req.body.endTimeMadrid.trim()
          : existing.endTimeMadrid;
      const crossesMidnight =
        typeof req.body?.crossesMidnight === 'boolean'
          ? req.body.crossesMidnight
          : existing.crossesMidnight;
      const plannedBreakMinutes =
        req.body?.plannedBreakMinutes !== undefined
          ? Number(req.body.plannedBreakMinutes)
          : existing.plannedBreakMinutes;
      const validFrom =
        typeof req.body?.validFrom === 'string' ? req.body.validFrom.trim() : existing.validFrom;
      const validTo =
        req.body?.validTo === null
          ? null
          : typeof req.body?.validTo === 'string'
            ? req.body.validTo.trim() || null
            : existing.validTo;

      const boundsCheck = computePlannedShiftBounds({
        madridDateKey: validFrom,
        startTimeMadrid,
        endTimeMadrid,
        crossesMidnight,
        plannedBreakMinutes,
      });
      if (!boundsCheck.ok) {
        sendProblem(res, boundsCheck.status, 'Horario no válido', boundsCheck.reason);
        return;
      }

      const nowIso = nowProvider().toISOString();
      const updated = await repo.updateShiftTemplate(existing.id, {
        name: typeof req.body?.name === 'string' ? req.body.name.trim() : undefined,
        weekdays: Array.isArray(req.body?.weekdays)
          ? Array.from(
              new Set<number>(
                (req.body.weekdays as unknown[])
                  .map((v) => Number(v))
                  .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7),
              ),
            ).sort((a, b) => a - b)
          : undefined,
        startTimeMadrid,
        endTimeMadrid,
        crossesMidnight,
        plannedBreakMinutes: boundsCheck.plannedBreakMinutes,
        projectRef:
          req.body?.projectRef === null
            ? null
            : typeof req.body?.projectRef === 'string'
              ? req.body.projectRef.trim() || null
              : undefined,
        facilityRef:
          req.body?.facilityRef === null
            ? null
            : typeof req.body?.facilityRef === 'string'
              ? req.body.facilityRef.trim() || null
              : undefined,
        validFrom,
        validTo,
        isActive: typeof req.body?.isActive === 'boolean' ? req.body.isActive : undefined,
        updatedAt: nowIso,
      });

      if (!updated) {
        sendProblem(res, 404, 'Plantilla no encontrada', 'No se pudo actualizar la plantilla.');
        return;
      }

      await repo.appendAuditLog({
        id: crypto.randomUUID(),
        actorUserId: authUser.id,
        action: 'shift_template.updated',
        entityType: 'shift_template',
        entityId: updated.id,
        details: { employeeId: updated.employeeId, before: existing, after: updated },
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
        createdAt: nowIso,
      });

      res.json({ template: updated });
    },
  );

  app.delete(
    '/api/v1/admin/shift-templates/:id',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const existing = await repo.findShiftTemplateById(req.params.id);
      if (!existing) {
        sendProblem(res, 404, 'Plantilla no encontrada', 'La plantilla indicada no existe.');
        return;
      }
      await repo.deleteShiftTemplate(existing.id);
      const nowIso = nowProvider().toISOString();
      await repo.appendAuditLog({
        id: crypto.randomUUID(),
        actorUserId: authUser.id,
        action: 'shift_template.deleted',
        entityType: 'shift_template',
        entityId: existing.id,
        details: { employeeId: existing.employeeId, before: existing },
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
        createdAt: nowIso,
      });
      res.json({ ok: true });
    },
  );

  app.get('/api/v1/admin/day-offs', requireAuth, requireAdmin, async (req, res) => {
    const employeeId =
      typeof req.query.employeeId === 'string' && req.query.employeeId.trim()
        ? req.query.employeeId.trim()
        : undefined;
    const fromDate =
      typeof req.query.from === 'string' && isValidDateKey(req.query.from)
        ? req.query.from
        : undefined;
    const toDate =
      typeof req.query.to === 'string' && isValidDateKey(req.query.to) ? req.query.to : undefined;
    const dayOffs = await repo.listDayOffs({ employeeId, fromDate, toDate });
    res.json({ dayOffs });
  });

  app.post(
    '/api/v1/admin/day-offs',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const madridDate =
        typeof req.body?.madridDate === 'string' ? req.body.madridDate.trim() : '';
      const type = req.body?.type as DayOffType;
      const employeeId =
        typeof req.body?.employeeId === 'string' && req.body.employeeId.trim()
          ? req.body.employeeId.trim()
          : null;
      const note =
        typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim() : null;

      if (!isValidDateKey(madridDate) || !['free', 'holiday', 'absence'].includes(type)) {
        sendProblem(
          res,
          422,
          'Datos no válidos',
          'Debes indicar una fecha YYYY-MM-DD válida y un tipo (free, holiday o absence).',
        );
        return;
      }

      const nowIso = nowProvider().toISOString();
      const dayOff = await repo.createDayOff({
        id: crypto.randomUUID(),
        employeeId,
        madridDate,
        type,
        note,
        createdAt: nowIso,
      });

      await repo.appendAuditLog({
        id: crypto.randomUUID(),
        actorUserId: authUser.id,
        action: 'day_off.created',
        entityType: 'day_off',
        entityId: dayOff.id,
        details: { after: dayOff },
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
        createdAt: nowIso,
      });

      res.status(201).json({ dayOff });
    },
  );

  app.delete(
    '/api/v1/admin/day-offs/:id',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const existing = await repo.findDayOffById(req.params.id);
      if (!existing) {
        sendProblem(res, 404, 'Registro no encontrado', 'El día libre/festivo indicado no existe.');
        return;
      }
      await repo.deleteDayOff(existing.id);
      const nowIso = nowProvider().toISOString();
      await repo.appendAuditLog({
        id: crypto.randomUUID(),
        actorUserId: authUser.id,
        action: 'day_off.deleted',
        entityType: 'day_off',
        entityId: existing.id,
        details: { before: existing },
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
        createdAt: nowIso,
      });
      res.json({ ok: true });
    },
  );

  app.get('/api/v1/admin/policies', requireAuth, requireAdmin, async (_req, res) => {
    const policy = await repo.getClockPolicy();
    res.json({ policy });
  });

  app.put(
    '/api/v1/admin/policies',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const before = await repo.getClockPolicy();

      const pastPlannedEndMinutes =
        req.body?.pastPlannedEndMinutes !== undefined
          ? Number(req.body.pastPlannedEndMinutes)
          : before.pastPlannedEndMinutes;
      const flagAfterEndMinutes =
        req.body?.flagAfterEndMinutes !== undefined
          ? Number(req.body.flagAfterEndMinutes)
          : before.flagAfterEndMinutes;
      const maxOpenHours =
        req.body?.maxOpenHours !== undefined
          ? Number(req.body.maxOpenHours)
          : before.maxOpenHours;
      const maxDailyMinutes =
        req.body?.maxDailyMinutes !== undefined
          ? Number(req.body.maxDailyMinutes)
          : before.maxDailyMinutes;
      const scheduleToleranceMinutes =
        req.body?.scheduleToleranceMinutes !== undefined
          ? Number(req.body.scheduleToleranceMinutes)
          : before.scheduleToleranceMinutes;
      const overrunPolicy: OverrunPolicy =
        req.body?.overrunPolicy === 'cap_provisional' || req.body?.overrunPolicy === 'flag_only'
          ? req.body.overrunPolicy
          : before.overrunPolicy;
      const requirePlannedShift =
        typeof req.body?.requirePlannedShift === 'boolean'
          ? req.body.requirePlannedShift
          : before.requirePlannedShift;

      if (
        !Number.isFinite(pastPlannedEndMinutes) ||
        pastPlannedEndMinutes < 0 ||
        !Number.isFinite(flagAfterEndMinutes) ||
        flagAfterEndMinutes < pastPlannedEndMinutes ||
        !Number.isFinite(maxOpenHours) ||
        maxOpenHours < 1 ||
        !Number.isFinite(maxDailyMinutes) ||
        maxDailyMinutes < 60 ||
        !Number.isFinite(scheduleToleranceMinutes) ||
        scheduleToleranceMinutes < 0
      ) {
        sendProblem(
          res,
          422,
          'Política no válida',
          'Revisa los umbrales numéricos de política de fichajes.',
        );
        return;
      }

      const nowIso = nowProvider().toISOString();
      const updated = await repo.updateClockPolicy({
        pastPlannedEndMinutes: Math.round(pastPlannedEndMinutes),
        flagAfterEndMinutes: Math.round(flagAfterEndMinutes),
        maxOpenHours: Math.round(maxOpenHours),
        maxDailyMinutes: Math.round(maxDailyMinutes),
        scheduleToleranceMinutes: Math.round(scheduleToleranceMinutes),
        overrunPolicy,
        requirePlannedShift,
        updatedAt: nowIso,
      });

      await repo.appendAuditLog({
        id: crypto.randomUUID(),
        actorUserId: authUser.id,
        action: 'clock_policy.updated',
        entityType: 'clock_policy',
        entityId: updated.id,
        details: { before, after: updated },
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
        createdAt: nowIso,
      });

      await watchdogCoordinator.runNow(true);
      res.json({ policy: updated });
    },
  );

  app.post('/api/v1/admin/watchdog/run', requireAuth, requireAdmin, async (_req, res) => {
    const summary = await watchdogCoordinator.runNow(true);
    res.json({ summary });
  });

  app.get('/api/v1/admin/open-sessions', requireAuth, requireAdmin, async (_req, res) => {
    await watchdogCoordinator.runNow(true);

    const nowMs = nowProvider().getTime();
    const [employees, sessions, incidents, plannedShifts] = await Promise.all([
      repo.listEmployees(true),
      repo.listWorkSessions(),
      repo.listSessionIncidents(),
      repo.listPlannedShifts(),
    ]);

    const empMap = new Map(employees.map((e) => [e.id, e]));
    const shiftMap = new Map(plannedShifts.map((p) => [p.id, p]));

    const flaggedOrOpen = sessions.filter(
      (s) =>
        s.status === 'flagged' ||
        s.status === 'incomplete' ||
        (s.status === 'open' && s.anomalyFlags.includes('past_planned_end')),
    );

    const openSessions: AdminOpenSessionView[] = flaggedOrOpen
      .map((s) => {
        const emp = empMap.get(s.employeeId);
        const planned = s.plannedShiftId ? shiftMap.get(s.plannedShiftId) ?? null : null;
        const plannedEndUtc = s.plannedEndUtc ?? planned?.endUtc ?? null;
        const overrunMinutes = plannedEndUtc
          ? Math.max(0, Math.round((nowMs - Date.parse(plannedEndUtc)) / 60_000))
          : Math.max(0, Math.round((nowMs - Date.parse(s.startUtc)) / 60_000));
        const incident =
          incidents.find((inc) => inc.sessionId === s.id && inc.status !== 'resolved') ??
          incidents.find((inc) => inc.sessionId === s.id) ??
          null;

        return {
          session: s,
          employeeName: emp?.name ?? s.employeeId,
          employeeEmail: emp?.email ?? '',
          externalRef: emp?.externalRef ?? null,
          plannedStartUtc: planned?.startUtc ?? null,
          plannedEndUtc,
          overrunMinutes,
          incident,
        };
      })
      .sort((a, b) => b.overrunMinutes - a.overrunMinutes);

    const openIncidentCount = incidents.filter((inc) => inc.status === 'open').length;
    res.json({ openSessions, openIncidentCount });
  });

  app.post(
    '/api/v1/admin/incidents/:id/acknowledge',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const authUser = req.authUser!;
      const nowIso = nowProvider().toISOString();
      const updated = await repo.acknowledgeIncident(req.params.id, authUser.id, nowIso);
      if (!updated) {
        sendProblem(res, 404, 'Incidencia no encontrada', 'La incidencia indicada no existe.');
        return;
      }

      await repo.appendAuditLog({
        id: crypto.randomUUID(),
        actorUserId: authUser.id,
        action: 'incident.acknowledged',
        entityType: 'session_incident',
        entityId: updated.id,
        details: { sessionId: updated.sessionId, employeeId: updated.employeeId },
        ipAddress: getClientIp(req),
        userAgent: getUserAgent(req),
        createdAt: nowIso,
      });

      res.json({ incident: updated });
    },
  );

  app.get('/api/v1/admin/daily-summary', requireAuth, requireAdmin, async (req, res) => {
    const todayKey = getMadridDateKey(nowProvider().toISOString());
    const from =
      typeof req.query.from === 'string' && req.query.from.trim()
        ? req.query.from.trim()
        : getMondayOfWeek(todayKey);
    const to =
      typeof req.query.to === 'string' && req.query.to.trim() ? req.query.to.trim() : todayKey;
    const employeeId =
      typeof req.query.employeeId === 'string' && req.query.employeeId.trim()
        ? req.query.employeeId.trim()
        : undefined;

    if (!isValidDateKey(from) || !isValidDateKey(to) || from > to) {
      sendProblem(res, 422, 'Rango no válido', 'Indica fechas from/to válidas (from <= to).');
      return;
    }

    const [allEmployees, policy, dayOffs] = await Promise.all([
      repo.listEmployees(true),
      repo.getClockPolicy(),
      repo.listDayOffs({ employeeId, fromDate: from, toDate: to }),
    ]);

    const targetEmployees = employeeId
      ? allEmployees.filter((e) => e.id === employeeId)
      : allEmployees;

    const nowMs = nowProvider().getTime();
    const plannedShifts: PlannedShift[] = [];
    for (const emp of targetEmployees) {
      await evaluateEmployeeSessionsWithWatchdog({
        repo,
        gateway,
        employeeId: emp.id,
        employeeExternalRef: emp.externalRef,
        nowMs,
        anomalyConfig,
      });
      const assigned = await gateway.getAssignments({
        employeeId: emp.id,
        employeeExternalRef: emp.externalRef,
        fromDateKey: from,
        toDateKey: to,
      });
      plannedShifts.push(...assigned);
    }

    const sessions = await repo.listWorkSessions(employeeId);
    const rows = buildDailySummary({
      employees: targetEmployees,
      fromDateKey: from,
      toDateKey: to,
      plannedShifts,
      sessions,
      dayOffs,
      toleranceMinutes: policy.scheduleToleranceMinutes,
    });

    res.json({ rows, from, to });
  });

  app.get(
    '/api/v1/admin/audit-log',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
      const entries = await repo.listAuditLog(limit);
      res.json({ entries });
    },
  );

  app.get(
    '/api/v1/admin/outbox',
    requireAuth,
    requireAdmin,
    async (_req, res) => {
      const items = await repo.listOutboxItems();
      res.json({ items });
    },
  );

  app.post(
    '/api/v1/admin/outbox/process',
    requireAuth,
    requireAdmin,
    async (req: AuthenticatedRequest, res) => {
      const summary = await flushCorrectionOutbox(
        req.authUser!.id,
        getClientIp(req),
        getUserAgent(req),
      );
      const items = await repo.listOutboxItems();
      res.json({ ...summary, items });
    },
  );

  // --- RUTAS DE ADMINISTRACIÓN EXISTENTES ---
  app.get('/api/admin/overview', requireAuth, requireAdmin, async (_req, res) => {
    await watchdogCoordinator.runNow(false);

    const [employees, allEvents, breakTypes, policy, savedSessions] = await Promise.all([
      repo.listEmployees(),
      repo.listClockEvents(),
      repo.listBreakTypes(false),
      repo.getClockPolicy(),
      repo.listWorkSessions(),
    ]);

    const nowMs = nowProvider().getTime();
    const todayKey = getMadridDateKey(new Date(nowMs).toISOString());
    const incompleteIds = new Set(
      savedSessions.filter((s) => s.status === 'incomplete').map((s) => s.id),
    );
    const eventsByEmp = new Map<string, ClockEvent[]>();
    for (const ev of allEvents) {
      const list = eventsByEmp.get(ev.employeeId) ?? [];
      list.push(ev);
      eventsByEmp.set(ev.employeeId, list);
    }

    const overview = employees.map((emp) => {
      const empEvents = eventsByEmp.get(emp.id) ?? [];
      const snap = computeWorkState(empEvents, nowMs, breakTypes, {
        maxOpenHours: policy.maxOpenHours,
        incompleteSessionIds: incompleteIds,
      });
      const todayEvents = empEvents.filter((e) => getMadridDateKey(e.deviceDeclaredAt) === todayKey);
      const todaySnap = computeWorkState(todayEvents, nowMs, breakTypes, {
        maxOpenHours: policy.maxOpenHours,
        incompleteSessionIds: incompleteIds,
      });
      const pendingSyncCount = empEvents.filter((e) => e.syncStatus === 'enviado').length;

      return {
        id: emp.id,
        userId: emp.userId,
        email: emp.email,
        name: emp.name,
        role: emp.role,
        externalRef: emp.externalRef,
        status: emp.status,
        workState: snap.workState,
        activeShiftStart: snap.activeShiftStart,
        todayEffectiveMs: snap.workState === 'fuera' ? todaySnap.effectiveMs : snap.effectiveMs,
        pendingSyncCount,
      };
    });

    res.json({ employees: overview, totalEvents: allEvents.length });
  });

  app.get('/api/admin/employees', requireAuth, requireAdmin, async (_req, res) => {
    const employees = await repo.listEmployees();
    res.json({ employees });
  });

  app.post('/api/admin/employees', requireAuth, requireAdmin, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const role: UserRole = req.body?.role === 'admin' ? 'admin' : 'employee';
    const externalRef =
      typeof req.body?.externalRef === 'string' && req.body.externalRef.trim()
        ? req.body.externalRef.trim()
        : null;

    if (!email || !email.includes('@') || !name || password.length < 6) {
      res.status(400).json({
        error: 'Nombre, email válido y contraseña de al menos 6 caracteres son obligatorios.',
      });
      return;
    }

    const existing = await repo.findUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: 'Ya existe un usuario con ese correo electrónico.' });
      return;
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const employee = await repo.createUserAndEmployee({
      userId: crypto.randomUUID(),
      employeeId: crypto.randomUUID(),
      email,
      passwordHash,
      role,
      name,
      externalRef,
    });

    res.status(201).json({ employee });
  });

  app.patch('/api/admin/employees/:id', requireAuth, requireAdmin, async (req, res) => {
    const updated = await repo.updateEmployee(req.params.id, {
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      externalRef:
        req.body?.externalRef === null
          ? null
          : typeof req.body?.externalRef === 'string'
            ? req.body.externalRef.trim() || null
            : undefined,
      status:
        req.body?.status === 'active' || req.body?.status === 'inactive' ? req.body.status : undefined,
      isUserActive: typeof req.body?.isUserActive === 'boolean' ? req.body.isUserActive : undefined,
    });

    if (!updated) {
      res.status(404).json({ error: 'Empleado no encontrado.' });
      return;
    }
    res.json({ employee: updated });
  });

  app.post('/api/admin/break-types', requireAuth, requireAdmin, async (req, res) => {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const isPaid = Boolean(req.body?.isPaid);

    if (!code || !name) {
      res.status(400).json({ error: 'El código y el nombre del tipo de pausa son obligatorios.' });
      return;
    }

    try {
      const breakType = await repo.createBreakType({
        id: crypto.randomUUID(),
        code,
        name,
        isPaid,
      });
      res.status(201).json({ breakType });
    } catch {
      res.status(409).json({ error: 'Ya existe un tipo de pausa con ese código.' });
    }
  });

  app.patch('/api/admin/break-types/:id', requireAuth, requireAdmin, async (req, res) => {
    const updated = await repo.updateBreakType(req.params.id, {
      name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      isPaid: typeof req.body?.isPaid === 'boolean' ? req.body.isPaid : undefined,
      isActive: typeof req.body?.isActive === 'boolean' ? req.body.isActive : undefined,
    });

    if (!updated) {
      res.status(404).json({ error: 'Tipo de pausa no encontrado.' });
      return;
    }
    res.json({ breakType: updated });
  });

  // --- CONTRATO REST INTEGRACIÓN MiTa v2.0 (Laravel 12) ---
  const requireMitaAccess = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ): Promise<void> => {
    const providedKey = req.headers['x-mita-api-key'];
    if (mitaSyncKey && typeof providedKey === 'string' && providedKey === mitaSyncKey) {
      next();
      return;
    }
    await requireAuth(req, res, () => {
      requireAdmin(req, res, next);
    });
  };

  app.get('/api/mita/v1/events', requireMitaAccess, async (req, res) => {
    const statusParam = req.query.status;
    const status: SyncStatus | undefined =
      statusParam === 'enviado' || statusParam === 'confirmado' ? statusParam : undefined;
    const limitRaw = Number(req.query.limit ?? 100);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, limitRaw) : 100;

    const events = await repo.listMitaExportEvents(status, limit);
    res.json({
      schema_version: 'mita-clock.v1',
      timezone: 'UTC',
      business_timezone: 'Europe/Madrid',
      count: events.length,
      events,
    });
  });

  app.post('/api/mita/v1/confirm', requireMitaAccess, async (req, res) => {
    const eventIds = Array.isArray(req.body?.event_ids)
      ? req.body.event_ids.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    if (eventIds.length === 0) {
      res.status(400).json({ error: 'Debes indicar event_ids para confirmar.' });
      return;
    }

    const ackRef =
      typeof req.body?.mita_ack_ref === 'string' && req.body.mita_ack_ref.trim()
        ? req.body.mita_ack_ref.trim()
        : `MITA-${Date.now()}`;
    const confirmedAtUtc = nowProvider().toISOString();
    const confirmedCount = await repo.acknowledgeEvents(eventIds, ackRef, confirmedAtUtc);

    res.json({
      ok: true,
      mita_ack_ref: ackRef,
      confirmed_at_utc: confirmedAtUtc,
      confirmedCount,
    });
  });

  // Registro de errores sanitizado (sin exponer credenciales ni cadenas de conexión)
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const msg = err instanceof Error ? sanitizeSecretString(err.message) : 'Error interno';
      console.error(`[API Error] ${req.method} ${req.originalUrl}: ${msg}`);
      if (res.headersSent) return;
      if (req.originalUrl.startsWith('/api/v1/')) {
        sendProblem(res, 500, 'Error interno del servidor', 'No se pudo completar la operación.');
        return;
      }
      res.status(500).json({ error: 'Error interno del servidor.' });
    },
  );

  return app;
}

interface RawIncomingEvent {
  id?: unknown;
  type?: unknown;
  breakTypeId?: unknown;
  deviceDeclaredAt?: unknown;
  deviceOffsetMs?: unknown;
  assignmentRef?: unknown;
  projectRef?: unknown;
  facilityRef?: unknown;
  offline?: unknown;
}

async function processIncomingEvents(
  repo: ClockRepository,
  gateway: MitaGateway,
  employeeId: string,
  rawList: RawIncomingEvent[],
  nowProvider: () => Date,
): Promise<
  | { ok: true; results: Array<{ event: ClockEvent; deduplicated: boolean }> }
  | { ok: false; status: number; error: string }
> {
  const employee = await repo.findEmployeeById(employeeId);
  if (!employee || employee.status !== 'active' || !employee.isUserActive) {
    return { ok: false, status: 403, error: 'El empleado no está activo para fichar.' };
  }

  const orderedInput = [...rawList].sort((a, b) => {
    const da = typeof a.deviceDeclaredAt === 'string' ? Date.parse(a.deviceDeclaredAt) : 0;
    const db = typeof b.deviceDeclaredAt === 'string' ? Date.parse(b.deviceDeclaredAt) : 0;
    return da - db;
  });

  const [existingEvents, policy, savedSessions] = await Promise.all([
    repo.listClockEvents({ employeeId }),
    repo.getClockPolicy(),
    repo.listWorkSessions(employeeId),
  ]);
  const incompleteSessionIds = new Set<string>(
    savedSessions.filter((s) => s.status === 'incomplete').map((s) => s.id),
  );
  const simulatedEvents = [...existingEvents];
  const results: Array<{ event: ClockEvent; deduplicated: boolean }> = [];

  for (const raw of orderedInput) {
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!UUID_REGEX.test(id)) {
      return { ok: false, status: 400, error: 'Cada evento requiere un id UUID válido.' };
    }

    const type = raw.type as ClockEventType;
    if (!VALID_EVENT_TYPES.has(type)) {
      return { ok: false, status: 400, error: 'Tipo de evento no válido.' };
    }

    const alreadyExists = await repo.findClockEventById(id);
    if (alreadyExists) {
      if (alreadyExists.employeeId !== employeeId) {
        return { ok: false, status: 409, error: 'Conflicto de identificador de evento.' };
      }
      results.push({ event: alreadyExists, deduplicated: true });
      continue;
    }

    const serverNow = nowProvider();
    const receivedAt = serverNow.toISOString();
    const parsedDeclared =
      typeof raw.deviceDeclaredAt === 'string' && !Number.isNaN(Date.parse(raw.deviceDeclaredAt))
        ? new Date(raw.deviceDeclaredAt).toISOString()
        : receivedAt;
    const declaredMs = Date.parse(parsedDeclared);
    const declaredDateKey = getMadridDateKey(parsedDeclared);

    // Si es un shift_start de un día posterior y quedó una jornada abierta del día anterior
    // que ya superó su margen (no es un turno nocturno activo), marcarla como incomplete
    // para que no bloquee el nuevo fichaje.
    if (type === 'shift_start') {
      const priorShifts = buildShiftsFromEvents(simulatedEvents, [], declaredMs);
      const lastOpen = priorShifts.length > 0 ? priorShifts[priorShifts.length - 1] : null;
      if (lastOpen && lastOpen.isOpen && lastOpen.madridDateKey < declaredDateKey) {
        const nearbyAssignments = await gateway.getAssignments({
          employeeId,
          employeeExternalRef: employee.externalRef,
          fromDateKey: addDaysToDateKey(lastOpen.madridDateKey, -1),
          toDateKey: addDaysToDateKey(declaredDateKey, 1),
        });
        const matchedPlan = findPlannedShiftForShift(lastOpen, nearbyAssignments);
        const isActiveNightShift = Boolean(
          matchedPlan &&
            Date.parse(matchedPlan.endUtc) + policy.flagAfterEndMinutes * 60_000 > declaredMs,
        );
        if (!isActiveNightShift) {
          incompleteSessionIds.add(lastOpen.id);
        }
      }
    }

    const currentSnapshot = computeWorkState(
      simulatedEvents,
      declaredMs,
      [],
      type === 'shift_start'
        ? {
            maxOpenHours: policy.maxOpenHours,
            incompleteSessionIds,
          }
        : {
            maxOpenHours: Number.POSITIVE_INFINITY,
          },
    );
    const transition = validateTransition(currentSnapshot.workState, type);
    if (!transition.ok) {
      return { ok: false, status: 409, error: transition.reason };
    }

    if (type === 'shift_start' && policy.requirePlannedShift) {
      const assignments = await gateway.getAssignments({
        employeeId,
        employeeExternalRef: employee.externalRef,
        fromDateKey: addDaysToDateKey(declaredDateKey, -1),
        toDateKey: addDaysToDateKey(declaredDateKey, 1),
      });
      const matched = findPlannedShiftForShift(
        {
          employeeId,
          startUtc: parsedDeclared,
          madridDateKey: declaredDateKey,
        },
        assignments,
      );
      if (!matched) {
        return {
          ok: false,
          status: 422,
          error: 'No tienes una jornada planificada activa para fichar la entrada en este momento.',
        };
      }
    }

    const deltaMs = Math.abs(serverNow.getTime() - declaredMs);
    const isDeviceDeclared = Boolean(raw.offline) || deltaMs > 15_000;
    const deviceOffsetMs =
      typeof raw.deviceOffsetMs === 'number' && Number.isFinite(raw.deviceOffsetMs)
        ? Math.round(raw.deviceOffsetMs)
        : 0;

    const inserted = await repo.insertClockEvent({
      id,
      employeeId,
      type,
      breakTypeId: typeof raw.breakTypeId === 'string' && raw.breakTypeId ? raw.breakTypeId : null,
      receivedAt,
      deviceDeclaredAt: parsedDeclared,
      deviceOffsetMs,
      timeSource: isDeviceDeclared ? 'device_declared' : 'server',
      source: 'employee',
      correctsEventId: null,
      correctionId: null,
      assignmentRef:
        typeof raw.assignmentRef === 'string' && raw.assignmentRef.trim() ? raw.assignmentRef.trim() : null,
      projectRef:
        typeof raw.projectRef === 'string' && raw.projectRef.trim() ? raw.projectRef.trim() : null,
      facilityRef:
        typeof raw.facilityRef === 'string' && raw.facilityRef.trim() ? raw.facilityRef.trim() : null,
    });

    simulatedEvents.push(inserted.event);
    results.push(inserted);
  }

  return { ok: true, results };
}

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { UserPublic, UserRole } from '../shared/types.ts';
import type { ClockRepository } from './repository.ts';

export const SESSION_COOKIE_NAME = 'mita_session';

export interface SessionClaims {
  sub: string;
  role: UserRole;
  email: string;
}

export interface AuthenticatedRequest extends Request {
  authUser?: UserPublic;
}

export class LoginRateLimiter {
  private attempts = new Map<string, number[]>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(maxAttempts: number = 5, windowMs: number = 15 * 60 * 1000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  isBlocked(key: string, nowMs: number = Date.now()): { blocked: boolean; retryAfterSeconds: number } {
    const timestamps = this.prune(key, nowMs);
    if (timestamps.length < this.maxAttempts) {
      return { blocked: false, retryAfterSeconds: 0 };
    }
    const oldest = timestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - nowMs) / 1000));
    return { blocked: true, retryAfterSeconds };
  }

  recordFailure(key: string, nowMs: number = Date.now()): void {
    const timestamps = this.prune(key, nowMs);
    timestamps.push(nowMs);
    this.attempts.set(key, timestamps);
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  private prune(key: string, nowMs: number): number[] {
    const existing = this.attempts.get(key) ?? [];
    const filtered = existing.filter((t) => nowMs - t < this.windowMs);
    this.attempts.set(key, filtered);
    return filtered;
  }
}

export function isStrongJwtSecret(secret: string): boolean {
  const trimmed = secret.trim();
  if (trimmed.length < 32) return false;
  const lower = trimmed.toLowerCase();
  const weakPatterns = [
    'changeme',
    'change-me',
    'replace-me',
    'your-secret',
    'my_secret',
    'jwt_secret',
    'default-secret',
    'insecure',
    'secret123',
  ];
  return !weakPatterns.some((p) => lower.includes(p));
}

export function resolveJwtSecret(override?: string): string {
  if (override && override.trim().length > 0) return override.trim();
  const fromEnv = process.env.JWT_SECRET?.trim() ?? '';
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    if (!fromEnv || !isStrongJwtSecret(fromEnv)) {
      throw new Error(
        'JWT_SECRET es obligatorio y debe tener al menos 32 caracteres aleatorios en NODE_ENV=production. Genera uno con: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
      );
    }
    return fromEnv;
  }

  if (fromEnv.length > 0) return fromEnv;
  return crypto.randomBytes(32).toString('hex');
}

export function signSessionToken(claims: SessionClaims, secret: string): string {
  return jwt.sign(claims, secret, { expiresIn: '12h' });
}

export function verifySessionToken(token: string, secret: string): SessionClaims | null {
  try {
    const decoded = jwt.verify(token, secret) as jwt.JwtPayload;
    if (!decoded || typeof decoded.sub !== 'string' || typeof decoded.role !== 'string') {
      return null;
    }
    return {
      sub: decoded.sub,
      role: decoded.role as UserRole,
      email: String(decoded.email ?? ''),
    };
  } catch {
    return null;
  }
}

function getCookieOptions(req?: Request) {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'lax' as const,
      maxAge: 12 * 60 * 60 * 1000,
      path: '/',
    };
  }

  const isHttps = Boolean(
    req && (req.secure || req.headers['x-forwarded-proto'] === 'https'),
  );
  if (isHttps) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'none' as const,
      partitioned: true,
      maxAge: 12 * 60 * 60 * 1000,
      path: '/',
    };
  }

  return {
    httpOnly: true,
    secure: false,
    sameSite: 'lax' as const,
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  };
}

export function setSessionCookie(res: Response, token: string, req?: Request): void {
  res.cookie(SESSION_COOKIE_NAME, token, getCookieOptions(req));
}

export function clearSessionCookie(res: Response, req?: Request): void {
  const opts = getCookieOptions(req);
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    partitioned: 'partitioned' in opts ? opts.partitioned : undefined,
    path: '/',
  });
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }
  // Permitir llamadas con Bearer token o clave de integración MiTa sin cabecera cookie CSRF
  if (req.headers.authorization?.startsWith('Bearer ') || req.headers['x-mita-api-key']) {
    next();
    return;
  }
  const hasSessionCookie = Boolean(req.cookies?.[SESSION_COOKIE_NAME]);
  if (!hasSessionCookie) {
    // Login / demo-login aún no tienen cookie, pero aceptamos igualmente X-Requested-With o Origin coincidente
    next();
    return;
  }

  const xRequestedWith = req.headers['x-requested-with'];
  if (xRequestedWith === 'MiTaClock') {
    next();
    return;
  }

  const origin = req.headers.origin;
  const host = (req.headers['x-forwarded-host'] || req.headers.host) as string | undefined;
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost === host) {
        next();
        return;
      }
    } catch {
      // ignore invalid origin
    }
  }

  res.status(403).json({ error: 'Solicitud bloqueada por validación de origen.' });
}

function sendAuthProblemOrJson(
  req: Request,
  res: Response,
  status: number,
  title: string,
  detail: string,
): void {
  if (req.originalUrl.startsWith('/api/v1/')) {
    res
      .status(status)
      .setHeader('Content-Type', 'application/problem+json; charset=utf-8')
      .json({
        type: 'about:blank',
        title,
        status,
        detail,
        error: detail,
      });
    return;
  }
  res.status(status).json({ error: detail });
}

export function createAuthMiddleware(repo: ClockRepository, jwtSecret: string) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const cookieToken = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    const token = bearerToken || cookieToken;

    if (!token) {
      sendAuthProblemOrJson(req, res, 401, 'No autenticado', 'Sesión no iniciada.');
      return;
    }

    const claims = verifySessionToken(token, jwtSecret);
    if (!claims) {
      sendAuthProblemOrJson(req, res, 401, 'Sesión inválida', 'Sesión caducada o inválida.');
      return;
    }

    const user = await repo.findUserPublicById(claims.sub);
    if (!user || !user.isActive) {
      sendAuthProblemOrJson(
        req,
        res,
        401,
        'Usuario inactivo',
        'Usuario desactivado o inexistente.',
      );
      return;
    }

    req.authUser = user;
    next();
  };
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.authUser || req.authUser.role !== 'admin') {
    sendAuthProblemOrJson(
      req,
      res,
      403,
      'Acceso denegado',
      'Acceso restringido a administradores.',
    );
    return;
  }
  next();
}

export function requirePasswordChanged(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  if (req.authUser?.mustChangePassword) {
    if (req.originalUrl.startsWith('/api/v1/')) {
      res
        .status(403)
        .setHeader('Content-Type', 'application/problem+json; charset=utf-8')
        .json({
          type: 'about:blank',
          title: 'Cambio de contraseña obligatorio',
          status: 403,
          code: 'PASSWORD_CHANGE_REQUIRED',
          detail: 'Debes cambiar tu contraseña inicial antes de continuar.',
          error: 'Debes cambiar tu contraseña inicial antes de continuar.',
        });
      return;
    }
    res.status(403).json({
      code: 'PASSWORD_CHANGE_REQUIRED',
      error: 'Debes cambiar tu contraseña inicial antes de continuar.',
    });
    return;
  }
  next();
}

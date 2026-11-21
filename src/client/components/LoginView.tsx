import React, { useEffect, useState } from 'react';
import { Clock, Loader2, LogIn, ShieldCheck, UserCheck } from 'lucide-react';
import { api, ApiError, subscribeServerStatus, type ServerConnectionStatus } from '../api';
import type { DemoAccountInfo, UserPublic } from '../../shared/types';
import { PWAInstallButton } from './PWAInstallButton';

interface LoginViewProps {
  onAuthenticated: (user: UserPublic) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onAuthenticated }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [demoAccounts, setDemoAccounts] = useState<DemoAccountInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [demoLoadingEmail, setDemoLoadingEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerConnectionStatus>('idle');

  useEffect(() => subscribeServerStatus(setServerStatus), []);

  useEffect(() => {
    let active = true;
    api
      .getDemoAccounts()
      .then((res) => {
        if (active && res.enabled) {
          setDemoAccounts(res.accounts);
        }
      })
      .catch(() => {
        // Si no hay conexión inicial, omitimos cuentas demo sin romper el login
      });
    return () => {
      active = false;
    };
  }, []);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.login(email, password);
      onAuthenticated(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) {
        setError(err.message);
      } else {
        setError('El servidor está arrancando o no responde aún. Inténtalo de nuevo en unos segundos.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDemoLogin = async (demoEmail: string) => {
    setError(null);
    setDemoLoadingEmail(demoEmail);
    try {
      const res = await api.demoLogin(demoEmail);
      onAuthenticated(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) {
        setError(err.message);
      } else {
        setError('El servidor está arrancando. Inténtalo de nuevo en unos segundos.');
      }
    } finally {
      setDemoLoadingEmail(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8 sm:py-12 flex flex-col justify-center">
      <div className="mx-auto w-full max-w-4xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-5 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-white shadow-xs">
                <Clock className="h-6 w-6" aria-hidden="true" />
              </div>
              <span className="font-display text-2xl font-bold tracking-tight text-slate-900">
                MiTa Clock
              </span>
            </div>
            <PWAInstallButton />
          </div>

          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 text-balance">
            Control horario del centro deportivo
          </h1>
          <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
            Registra jornadas y pausas desde tu móvil incluso sin cobertura en vestuarios o pistas.
            Todos los fichajes se guardan en UTC y se atribuyen al día en hora peninsular (Europe/Madrid).
          </p>

          <div className="border-t border-slate-200 pt-4 text-xs text-slate-500 space-y-1">
            <p>Sin geolocalización ni biometría · Trazabilidad inmutable</p>
            <p>Preparado para sincronización REST con MiTa v2.0</p>
          </div>
        </div>

        <div className="lg:col-span-7 space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
            <h2 className="text-lg font-semibold text-slate-900">Acceso con credenciales</h2>
            <p className="mt-1 text-xs text-slate-500">
              Las cuentas nuevas las da de alta un administrador del centro.
            </p>

            {serverStatus === 'connecting' && (
              <div
                role="status"
                aria-live="polite"
                className="mt-4 flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs font-medium text-blue-800"
              >
                <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden="true" />
                Conectando con el servidor… (el arranque inicial puede tardar unos segundos)
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
              >
                {error}
              </div>
            )}

            <form onSubmit={handlePasswordLogin} className="mt-5 space-y-4">
              <div>
                <label htmlFor="login-email" className="block text-sm font-medium text-slate-700">
                  Correo electrónico
                </label>
                <input
                  id="login-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="nombre@centro.es"
                  className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>

              <div>
                <label htmlFor="login-password" className="block text-sm font-medium text-slate-700">
                  Contraseña
                </label>
                <input
                  id="login-password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="min-h-[48px] w-full inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50"
              >
                <LogIn className="h-4 w-4" aria-hidden="true" />
                {loading ? 'Comprobando...' : 'Iniciar sesión'}
              </button>
            </form>
          </div>

          {demoAccounts.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
              <h2 className="text-base font-semibold text-slate-900">
                Acceso rápido de pruebas
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Selecciona uno de los perfiles de ejemplo para probar la app inmediatamente.
              </p>

              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                {demoAccounts.map((acc) => {
                  const isBusy = demoLoadingEmail === acc.email;
                  return (
                    <button
                      key={acc.email}
                      type="button"
                      disabled={demoLoadingEmail !== null}
                      onClick={() => handleDemoLogin(acc.email)}
                      className="min-h-[60px] flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3 text-left transition hover:border-blue-300 hover:bg-blue-50/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 truncate">
                          {acc.role === 'admin' ? (
                            <ShieldCheck className="h-4 w-4 shrink-0 text-blue-600" aria-hidden="true" />
                          ) : (
                            <UserCheck className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                          )}
                          <span className="truncate">{acc.name}</span>
                        </div>
                        <p className="mt-0.5 text-xs text-slate-500 truncate">
                          {acc.role === 'admin' ? 'Administrador' : 'Empleado'} · {acc.areaLabel}
                        </p>
                      </div>
                      <span className="text-xs font-semibold text-blue-600 whitespace-nowrap shrink-0">
                        {isBusy ? 'Entrando...' : 'Entrar'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

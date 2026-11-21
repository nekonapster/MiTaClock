# MiTa Clock

PWA móvil de control horario para centro deportivo (React + Vite + Express + TypeScript + PostgreSQL), preparada para desplegar en **Render** (plan gratuito, Web Service único) con **PostgreSQL en Neon** y futura integración REST con **MiTa v2.0 (Laravel 12)**.

## Características principales

- **Control horario inmutable (`clock_events`)**: triggers PostgreSQL que impiden `UPDATE` y `DELETE`, con marcas temporales en `TIMESTAMPTZ` (UTC) y atribución de día de negocio en `Europe/Madrid`.
- **Modo offline en IndexedDB**: si el empleado pierde cobertura o el servidor gratuito de Render está despertando (~30–50 s), los fichajes quedan guardados localmente como `pendiente` y se sincronizan automáticamente sin errores ni pérdida de datos.
- **Módulo de corrección de fichajes**: flujo completo solicitud → aprobación/rechazo por otro administrador → eventos compensatorios (`source = 'admin'`) + `audit_log` + `mita_outbox`.
- **Planificación de jornadas y vigilancia de relojes olvidados**: plantillas semanales, festivos/ausencias, turnos nocturnos, políticas configurables y detección de incidencias (`past_planned_end`, `flagged`, `incomplete`).
- **Seguridad primer acceso**: las cuentas demo sembradas con `SEED_DEMO_DATA=true` exigen cambio de contraseña obligatorio en el primer inicio de sesión.

## Desarrollo local

```bash
npm install
npm run dev
```

Si `DATABASE_URL` no está definida en desarrollo local, el servidor usa un almacenamiento local con PGlite en `./data/pglite-dev`. Para usar PostgreSQL/Neon en local, copia `.env.example` a `.env` y define `DATABASE_URL`.

### Pruebas y compilación

```bash
npm run lint     # Verificación TypeScript
npm test         # Suite Vitest (usa TEST_DATABASE_URL si existe, o PGlite en memoria)
npm run build    # Compila frontend (dist/) y backend (server.js)
```

---

## Despliegue en producción: Neon + Render (plan gratuito)

### 1. Crear base de datos en Neon

1. Entra en [Neon](https://neon.tech) y crea un proyecto en la región **AWS Europe (Frankfurt - `eu-central-1`)** para minimizar latencia junto a Render Frankfurt.
2. En **Connection Details**, copia:
   - **Pooled connection string** (lleva `-pooler` y `?sslmode=require`) → será `DATABASE_URL`.
   - **Direct (unpooled) connection string** (opcional, sin `-pooler`) → será `DATABASE_URL_UNPOOLED` (se usa únicamente al aplicar migraciones con `pg_advisory_lock`).
3. No necesitas ejecutar SQL manual: las migraciones versionadas (`schema_migrations`) se aplican automáticamente al arrancar.

### 2. Generar `JWT_SECRET` seguro

Ejecuta en tu terminal:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Guarda la cadena generada; el servidor en `NODE_ENV=production` **se negará a arrancar** si `JWT_SECRET` falta o es débil.

### 3. Crear el Web Service en Render

Puedes importar `render.yaml` directamente (**New → Blueprint**) o configurar manualmente un **Web Service (Node, Free, Frankfurt)**:

- **Build Command**: `npm install --include=dev && npm run build`
- **Start Command**: `npm start`
- **Health Check Path**: `/health`

#### Variables de entorno en Render

| Variable | Valor / Descripción | Obligatoria |
|---|---|---|
| `NODE_ENV` | `production` | Sí |
| `DATABASE_URL` | Cadena *pooled* de Neon (`postgresql://...?sslmode=require`) | Sí |
| `DATABASE_URL_UNPOOLED` | Cadena *direct/unpooled* de Neon (solo migraciones) | Recomendada |
| `JWT_SECRET` | Secreto aleatorio generado (mín. 32 caracteres) | Sí |
| `MITA_MODE` | `fake` | Sí |
| `SEED_DEMO_DATA` | `true` solo la primera vez si quieres crear 1 admin + 3 empleados demo (pon `false` después o en entorno real) | Opcional (`false`) |
| `ALLOW_DEMO_AUTH` | `false` en producción real (`true` solo para entorno de demostración) | Opcional (`false`) |
| `MITA_SYNC_KEY` | Clave compartida para `X-MiTa-Api-Key` de MiTa v2.0 | Opcional |

### 4. Verificar que funciona (`/health`)

Tras completar el despliegue, abre o consulta:

```bash
curl -i https://tu-servicio.onrender.com/health
```

Debe responder `HTTP/1.1 200 OK` con:

```json
{"ok":true,"status":"ok","db":"up","service":"MiTa Clock","timezone":"Europe/Madrid"}
```

## Limitaciones conocidas del plan gratuito (Render + Neon)

- **Arranque en frío (cold start)**: tras ~15 minutos sin tráfico, Render suspende el Web Service y Neon suspende la BD tras ~5 minutos de inactividad. La primera petición puede tardar entre 20 y 50 segundos; el servidor reintenta automáticamente la conexión PostgreSQL hasta ~30 s y la PWA muestra *"Conectando con el servidor…"* manteniendo cualquier fichaje seguro en IndexedDB.
- **Vigilancia de relojes olvidados (watchdog)**: mientras el servicio gratuito está dormido no corren temporizadores en segundo plano. Por eso el watchdog es idempotente y se ejecuta al arrancar, periódicamente mientras está despierto y al consultar vistas operativas (`/api/v1/clock/shifts/today`, `/api/v1/admin/open-sessions`, `/api/v1/admin/daily-summary`, `/api/v1/admin/overview`), recuperando automáticamente los tramos transcurridos durante la suspensión.

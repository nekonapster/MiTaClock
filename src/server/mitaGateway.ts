import crypto from 'node:crypto';
import { addDaysToDateKey } from '../shared/timeEngine.ts';
import { mergeMitaAndLocalShifts } from '../shared/planningEngine.ts';
import type { MitaCorrectionOutboxPayload, PlannedShift } from '../shared/types.ts';
import type { SqlExecutor } from './pgConnection.ts';
import type { ListPlannedShiftsFilter } from './repository.ts';

export type PlannedShiftReader = (filter: ListPlannedShiftsFilter) => Promise<PlannedShift[]>;

export interface MitaGateway {
  bindPlannedShiftReader?(reader: PlannedShiftReader): void;

  getAssignments(params: {
    employeeId: string;
    employeeExternalRef: string | null;
    fromDateKey: string;
    toDateKey: string;
  }): Promise<PlannedShift[]>;

  getNextShifts(
    employeeId: string,
    employeeExternalRef: string | null,
    fromDateKey: string,
    days?: number,
  ): Promise<PlannedShift[]>;

  sendCorrection(
    payload: MitaCorrectionOutboxPayload,
    idempotencyKey: string,
  ): Promise<{ ackRef: string }>;
}

export class FakeMitaGateway implements MitaGateway {
  public recordedCorrections: MitaCorrectionOutboxPayload[] = [];
  public deliveredKeys = new Set<string>();
  public failNextAttempts = 0;
  public customShiftsByEmployee = new Map<string, PlannedShift[]>();
  private plannedShiftReader: PlannedShiftReader | null = null;

  constructor(plannedShiftReader?: PlannedShiftReader) {
    this.plannedShiftReader = plannedShiftReader ?? null;
  }

  bindPlannedShiftReader(reader: PlannedShiftReader): void {
    this.plannedShiftReader = reader;
  }

  async getAssignments(params: {
    employeeId: string;
    employeeExternalRef: string | null;
    fromDateKey: string;
    toDateKey: string;
  }): Promise<PlannedShift[]> {
    const localShifts = this.plannedShiftReader
      ? await this.plannedShiftReader({
          employeeId: params.employeeId,
          fromDate: params.fromDateKey,
          toDate: params.toDateKey,
        })
      : [];

    const custom = (this.customShiftsByEmployee.get(params.employeeId) ?? []).filter(
      (s) => s.madridDateKey >= params.fromDateKey && s.madridDateKey <= params.toDateKey,
    );

    return mergeMitaAndLocalShifts(localShifts, custom);
  }

  async getNextShifts(
    employeeId: string,
    employeeExternalRef: string | null,
    fromDateKey: string,
    days: number = 7,
  ): Promise<PlannedShift[]> {
    return this.getAssignments({
      employeeId,
      employeeExternalRef,
      fromDateKey: addDaysToDateKey(fromDateKey, -7),
      toDateKey: addDaysToDateKey(fromDateKey, days),
    });
  }

  async sendCorrection(
    payload: MitaCorrectionOutboxPayload,
    idempotencyKey: string,
  ): Promise<{ ackRef: string }> {
    if (this.failNextAttempts > 0) {
      this.failNextAttempts -= 1;
      throw new Error('FakeMitaGateway: error temporal simulado de red');
    }
    if (this.deliveredKeys.has(idempotencyKey)) {
      return { ackRef: `FAKE-ACK-${idempotencyKey.slice(0, 8)}` };
    }
    this.deliveredKeys.add(idempotencyKey);
    this.recordedCorrections.push(payload);
    return { ackRef: `FAKE-ACK-${this.recordedCorrections.length}` };
  }
}

export class SimulatedMitaGateway implements MitaGateway {
  private readonly executor: SqlExecutor;
  private plannedShiftReader: PlannedShiftReader | null = null;

  constructor(executor: SqlExecutor, plannedShiftReader?: PlannedShiftReader) {
    this.executor = executor;
    this.plannedShiftReader = plannedShiftReader ?? null;
  }

  bindPlannedShiftReader(reader: PlannedShiftReader): void {
    this.plannedShiftReader = reader;
  }

  async getAssignments(params: {
    employeeId: string;
    employeeExternalRef: string | null;
    fromDateKey: string;
    toDateKey: string;
  }): Promise<PlannedShift[]> {
    if (this.plannedShiftReader) {
      return this.plannedShiftReader({
        employeeId: params.employeeId,
        fromDate: params.fromDateKey,
        toDate: params.toDateKey,
      });
    }

    const res = await this.executor.query<{
      id: string;
      employee_id: string;
      madrid_date: string;
      start_utc: unknown;
      end_utc: unknown;
      planned_break_minutes: number;
      planned_minutes: number;
      project_ref: string | null;
      facility_ref: string | null;
      assignment_ref: string | null;
      source: 'local' | 'mita';
      template_id: string | null;
      label: string;
    }>(
      `
        SELECT * FROM planned_shifts
        WHERE employee_id = $1 AND madrid_date >= $2 AND madrid_date <= $3
        ORDER BY start_utc ASC
      `,
      [params.employeeId, params.fromDateKey, params.toDateKey],
    );

    return res.rows.map((r) => ({
      id: r.id,
      employeeId: r.employee_id,
      madridDateKey: r.madrid_date,
      startUtc: r.start_utc instanceof Date ? r.start_utc.toISOString() : new Date(String(r.start_utc)).toISOString(),
      endUtc: r.end_utc instanceof Date ? r.end_utc.toISOString() : new Date(String(r.end_utc)).toISOString(),
      plannedBreakMinutes: Number(r.planned_break_minutes),
      plannedMinutes: Number(r.planned_minutes),
      projectRef: r.project_ref,
      facilityRef: r.facility_ref,
      assignmentRef: r.assignment_ref,
      source: r.source,
      templateId: r.template_id,
      label: r.label,
    }));
  }

  async getNextShifts(
    employeeId: string,
    employeeExternalRef: string | null,
    fromDateKey: string,
    days: number = 7,
  ): Promise<PlannedShift[]> {
    return this.getAssignments({
      employeeId,
      employeeExternalRef,
      fromDateKey: addDaysToDateKey(fromDateKey, -7),
      toDateKey: addDaysToDateKey(fromDateKey, days),
    });
  }

  async sendCorrection(
    payload: MitaCorrectionOutboxPayload,
    idempotencyKey: string,
  ): Promise<{ ackRef: string }> {
    const existingRes = await this.executor.query<{ ack_ref: string }>(
      'SELECT ack_ref FROM mita_simulated_corrections WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    if (existingRes.rows[0]) {
      return { ackRef: existingRes.rows[0].ack_ref };
    }

    const ackRef = `MITA-CORR-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    await this.executor.query(
      `
        INSERT INTO mita_simulated_corrections (
          id, idempotency_key, correction_id, session_id, payload_json, ack_ref, received_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [
        crypto.randomUUID(),
        idempotencyKey,
        payload.correctionId,
        payload.sessionId,
        JSON.stringify(payload),
        ackRef,
        new Date().toISOString(),
      ],
    );

    const finalRes = await this.executor.query<{ ack_ref: string }>(
      'SELECT ack_ref FROM mita_simulated_corrections WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    return { ackRef: finalRes.rows[0]?.ack_ref ?? ackRef };
  }
}

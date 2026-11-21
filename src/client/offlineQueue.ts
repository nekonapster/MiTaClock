import type { ClockEvent, QueuedClockEvent } from '../shared/types';

const DB_NAME = 'mita_clock_db';
const DB_VERSION = 1;
const STORE_NAME = 'outbox';
const FALLBACK_KEY = 'mita_clock_outbox_fallback_v1';

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('by_employee', 'employeeId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readFallback(): QueuedClockEvent[] {
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
    return raw ? (JSON.parse(raw) as QueuedClockEvent[]) : [];
  } catch {
    return [];
  }
}

function writeFallback(items: QueuedClockEvent[]): void {
  try {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(items));
  } catch {
    // ignore storage quota errors
  }
}

export async function enqueueOfflineEvent(event: QueuedClockEvent): Promise<void> {
  if (!hasIndexedDB()) {
    const list = readFallback();
    if (!list.some((item) => item.id === event.id)) {
      list.push(event);
      writeFallback(list);
    }
    return;
  }

  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(event);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getQueuedEvents(employeeId: string): Promise<QueuedClockEvent[]> {
  if (!hasIndexedDB()) {
    return readFallback()
      .filter((item) => item.employeeId === employeeId)
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  const db = await openDatabase();
  const items = await new Promise<QueuedClockEvent[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const index = tx.objectStore(STORE_NAME).index('by_employee');
    const req = index.getAll(employeeId);
    req.onsuccess = () => resolve((req.result as QueuedClockEvent[]) ?? []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return items.sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export async function removeQueuedEvents(ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  if (!hasIndexedDB()) {
    const idSet = new Set(ids);
    writeFallback(readFallback().filter((item) => !idSet.has(item.id)));
    return;
  }

  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const id of ids) {
      store.delete(id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export function queuedToClockEvent(q: QueuedClockEvent): ClockEvent {
  return {
    id: q.id,
    employeeId: q.employeeId,
    type: q.type,
    breakTypeId: q.breakTypeId,
    receivedAt: q.deviceDeclaredAt,
    deviceDeclaredAt: q.deviceDeclaredAt,
    deviceOffsetMs: q.deviceOffsetMs,
    timeSource: 'device_declared',
    source: 'employee',
    correctsEventId: null,
    correctionId: null,
    assignmentRef: q.assignmentRef,
    projectRef: q.projectRef,
    facilityRef: q.facilityRef,
    syncStatus: 'pendiente',
    mitaAckRef: null,
  };
}

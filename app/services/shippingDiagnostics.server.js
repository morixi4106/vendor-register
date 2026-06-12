/* global globalThis */

const STORE_KEY = Symbol.for('vendor-register.shippingDiagnostics');
const DEFAULT_MAX_EVENTS = 200;

function getStore() {
  if (!globalThis[STORE_KEY]) {
    globalThis[STORE_KEY] = {
      events: [],
      nextSequence: 1,
    };
  }

  return globalThis[STORE_KEY];
}

function normalizeText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeLimit(value) {
  const numeric = Number(value);

  if (!Number.isInteger(numeric) || numeric <= 0) {
    return DEFAULT_MAX_EVENTS;
  }

  return Math.min(numeric, DEFAULT_MAX_EVENTS);
}

export function createShippingDiagnosticId(prefix = 'ship') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function recordShippingDiagnosticEvent(event = {}) {
  const store = getStore();
  const normalized = {
    sequence: store.nextSequence,
    timestamp: new Date().toISOString(),
    requestId: normalizeText(event.requestId),
    source: normalizeText(event.source) || 'shipping',
    level: normalizeText(event.level) || 'info',
    message: normalizeText(event.message) || 'shipping_event',
    details: event.details ?? null,
  };

  store.nextSequence += 1;
  store.events.push(normalized);

  if (store.events.length > DEFAULT_MAX_EVENTS) {
    store.events.splice(0, store.events.length - DEFAULT_MAX_EVENTS);
  }

  return normalized;
}

export function listShippingDiagnosticEvents({ limit = DEFAULT_MAX_EVENTS, requestId = null } = {}) {
  const normalizedLimit = normalizeLimit(limit);
  const normalizedRequestId = normalizeText(requestId);
  const events = normalizedRequestId
    ? getStore().events.filter((event) => event.requestId === normalizedRequestId)
    : getStore().events;

  return events.slice(-normalizedLimit).reverse();
}

export function clearShippingDiagnosticEvents() {
  const store = getStore();
  store.events = [];
  store.nextSequence = 1;
}

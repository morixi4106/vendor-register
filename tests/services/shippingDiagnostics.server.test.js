import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearShippingDiagnosticEvents,
  createShippingDiagnosticId,
  listShippingDiagnosticEvents,
  recordShippingDiagnosticEvent,
} from '../../app/services/shippingDiagnostics.server.js';

test('shipping diagnostics stores recent events newest first', () => {
  clearShippingDiagnosticEvents();
  const requestId = createShippingDiagnosticId('test');

  recordShippingDiagnosticEvent({
    requestId,
    source: 'carrier',
    message: 'first',
  });
  recordShippingDiagnosticEvent({
    requestId,
    source: 'quote',
    level: 'warn',
    message: 'second',
    details: {
      reason: 'pending_address',
    },
  });

  const events = listShippingDiagnosticEvents({ limit: 2 });

  assert.equal(events.length, 2);
  assert.equal(events[0].message, 'second');
  assert.equal(events[0].level, 'warn');
  assert.equal(events[0].details.reason, 'pending_address');
  assert.equal(events[1].message, 'first');
});

import { json } from '@remix-run/node';
import { Form, useLoaderData, useNavigation } from '@remix-run/react';

import { authenticate } from '../shopify.server.js';
import {
  clearShippingDiagnosticEvents,
  listShippingDiagnosticEvents,
} from '../services/shippingDiagnostics.server.js';

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') || 100);

  return json({
    events: listShippingDiagnosticEvents({ limit }),
  });
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  clearShippingDiagnosticEvents();

  return json({
    ok: true,
  });
};

function formatDetails(details) {
  if (details == null) {
    return '';
  }

  return JSON.stringify(details, null, 2);
}

export default function ShippingDiagnosticsPage() {
  const { events } = useLoaderData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === 'submitting';

  return (
    <main style={{ maxWidth: 1200, margin: '0 auto', padding: 32 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1>Shipping Diagnostics</h1>
          <p>Recent CarrierService and Shipping V2 quote events for this running app instance.</p>
        </div>
        <Form method="post">
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Clearing...' : 'Clear'}
          </button>
        </Form>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 24 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Time</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Level</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Source</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Request</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Message</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Details</th>
          </tr>
        </thead>
        <tbody>
          {events.length === 0 ? (
            <tr>
              <td colSpan="6" style={{ padding: 16, color: '#666' }}>
                No shipping diagnostics recorded yet.
              </td>
            </tr>
          ) : (
            events.map((event) => (
              <tr key={`${event.sequence}-${event.timestamp}`}>
                <td style={{ borderBottom: '1px solid #eee', padding: 8, whiteSpace: 'nowrap' }}>
                  {event.timestamp}
                </td>
                <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>{event.level}</td>
                <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>{event.source}</td>
                <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>{event.requestId || '-'}</td>
                <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>{event.message}</td>
                <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>
                  <pre style={{ margin: 0, maxWidth: 520, whiteSpace: 'pre-wrap' }}>
                    {formatDetails(event.details)}
                  </pre>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </main>
  );
}

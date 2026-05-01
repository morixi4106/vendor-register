import { json } from '@remix-run/node';
import { Form, useActionData, useLoaderData, useNavigation } from '@remix-run/react';

import { authenticate } from '../shopify.server.js';
import {
  getCarrierCallbackUrl,
  upsertShippingV2CarrierService,
} from '../services/carrierShippingRates.server.js';

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const appUrl = process.env.APP_URL || 'https://low-alpine-hosts-contributed.trycloudflare.com';

  return json({
    shopDomain: session.shop,
    appUrl,
    callbackUrl: getCarrierCallbackUrl(appUrl),
  });
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const appUrl = process.env.APP_URL || 'https://low-alpine-hosts-contributed.trycloudflare.com';
  const result = await upsertShippingV2CarrierService({
    shopDomain: session.shop,
    appUrl,
  });

  return json(result);
};

export default function CarrierServicePage() {
  const data = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === 'submitting';

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 32 }}>
      <h1>Shipping V2 CarrierService</h1>
      <p>Shop: {data.shopDomain}</p>
      <p>APP_URL: {data.appUrl}</p>
      <p>Callback URL: {data.callbackUrl || 'APP_URL is not configured'}</p>
      <Form method="post">
        <button type="submit" disabled={isSubmitting || !data.callbackUrl}>
          {isSubmitting ? 'Registering...' : 'Create or update CarrierService'}
        </button>
      </Form>
      {actionData ? (
        <pre style={{ marginTop: 24, whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(actionData, null, 2)}
        </pre>
      ) : null}
    </main>
  );
}

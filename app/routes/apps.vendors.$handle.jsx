import { redirect } from '@remix-run/node';

import prisma from '../db.server';
import VendorStorefrontPage, {
  action,
  loader as vendorStorefrontLoader,
} from './vendor.$handle.jsx';

export { action };

export async function loader(args) {
  const handle = String(args.params.handle || '').trim();

  if (handle) {
    const vendor = await prisma.vendor.findUnique({
      where: { handle },
      select: { id: true },
    });

    if (!vendor) {
      const store = await prisma.vendorStore.findUnique({
        where: { id: handle },
        select: {
          vendorAuth: {
            select: {
              handle: true,
              status: true,
            },
          },
        },
      });
      const canonicalHandle = String(store?.vendorAuth?.handle || '').trim();

      if (canonicalHandle && store?.vendorAuth?.status === 'active') {
        throw redirect(`/apps/vendors/${canonicalHandle}`);
      }
    }
  }

  return vendorStorefrontLoader(args);
}

export default VendorStorefrontPage;

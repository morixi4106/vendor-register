import { json } from '@remix-run/node';
import { Link, useLoaderData } from '@remix-run/react';

import prisma from '../db.server.js';

export async function loader() {
  const vendors = await prisma.vendor.findMany({
    where: {
      status: 'active',
    },
    orderBy: {
      createdAt: 'desc',
    },
    include: {
      vendorStore: {
        include: {
          products: {
            where: {
              approvalStatus: 'approved',
            },
            select: {
              id: true,
            },
          },
        },
      },
    },
  });

  return json({
    vendors: vendors
      .filter((vendor) => vendor.vendorStore)
      .map((vendor) => ({
        id: vendor.id,
        handle: vendor.handle,
        storeName: vendor.vendorStore.storeName,
        country: vendor.vendorStore.country,
        category: vendor.vendorStore.category,
        approvedProductCount: vendor.vendorStore.products.length,
      })),
  });
}

export default function Vendors() {
  const { vendors } = useLoaderData();

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '40px 20px 72px' }}>
      <div style={{ marginBottom: '32px' }}>
        <p
          style={{
            margin: '0 0 12px',
            fontSize: '13px',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: '#8a6b57',
            fontWeight: 800,
          }}
        >
          Customer Storefront
        </p>
        <h1 style={{ fontSize: 'clamp(36px, 6vw, 64px)', fontWeight: 900, margin: 0 }}>
          出店者一覧
        </h1>
      </div>

      {vendors.length === 0 ? (
        <p style={{ fontSize: '18px', color: '#6a5446' }}>
          現在公開中の出店者はまだありません。
        </p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))',
            gap: '24px',
          }}
        >
          {vendors.map((vendor) => (
            <Link
              key={vendor.id}
              to={`/vendors/${vendor.handle}`}
              style={{
                display: 'grid',
                gap: '14px',
                border: '1px solid rgba(95,72,52,0.12)',
                padding: '22px',
                borderRadius: '22px',
                textDecoration: 'none',
                color: '#221a15',
                background: 'rgba(255,255,255,0.92)',
                boxShadow: '0 16px 48px rgba(72,49,35,0.08)',
              }}
            >
              <div
                style={{
                  display: 'inline-flex',
                  width: 'fit-content',
                  padding: '8px 12px',
                  borderRadius: '999px',
                  background: '#f4ebe2',
                  color: '#6a5446',
                  fontSize: '12px',
                  fontWeight: 800,
                }}
              >
                {vendor.country}
              </div>
              <div>
                <div style={{ fontSize: '24px', fontWeight: 900, marginBottom: '8px' }}>
                  {vendor.storeName}
                </div>
                <div style={{ color: '#6a5446', fontSize: '14px' }}>{vendor.category}</div>
              </div>
              <div style={{ color: '#6a5446', fontSize: '14px', fontWeight: 700 }}>
                公開商品 {vendor.approvedProductCount} 点
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

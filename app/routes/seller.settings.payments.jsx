import { json } from "@remix-run/node";
import { useEffect, useRef, useState } from "react";
import { useLoaderData } from "@remix-run/react";

import VendorManagementShell from "../components/vendor/VendorManagementShell";

export const loader = async ({ request }) => {
  const { requireVendorContext } = await import("../services/vendorManagement.server.js");
  const { getSellerPaymentsPageData } = await import("../services/sellerPayments.server.js");
  const { vendor } = await requireVendorContext(request);
  const pageData = await getSellerPaymentsPageData({ vendorId: vendor.id });

  return json(pageData);
};

export default function SellerPaymentsSettingsPage() {
  const data = useLoaderData();
  const onboardingRef = useRef(null);
  const managementRef = useRef(null);
  const notificationRef = useRef(null);
  const [componentState, setComponentState] = useState({
    loading: false,
    ready: false,
    error: null,
  });

  const hasStripeAccount = Boolean(data.stripeAccount?.stripeAccountId);
  const canRenderComponents = Boolean(
    data.stripePublishableKey && hasStripeAccount,
  );

  useEffect(() => {
    if (!canRenderComponents) {
      return undefined;
    }

    let cancelled = false;
    let connectInstance = null;
    const notificationNode = notificationRef.current;
    const onboardingNode = onboardingRef.current;
    const managementNode = managementRef.current;

    async function mountComponents() {
      setComponentState({
        loading: true,
        ready: false,
        error: null,
      });

      try {
        const [{ loadConnectAndInitialize }] = await Promise.all([
          import("@stripe/connect-js"),
        ]);

        connectInstance = loadConnectAndInitialize({
          publishableKey: data.stripePublishableKey,
          fetchClientSecret: async () => {
            const response = await fetch("/seller/connect/account-session", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({}),
            });
            const payload = await response.json();

            if (!response.ok || !payload?.clientSecret) {
              throw new Error(payload?.message || "Failed to create account session");
            }

            return payload.clientSecret;
          },
          appearance: {
            variables: {
              colorPrimary: "#111827",
              colorBackground: "#ffffff",
              colorText: "#111827",
              borderRadius: "12px",
            },
          },
        });

        if (cancelled) {
          return;
        }

        const notificationBanner = connectInstance.create("notification-banner");
        const onboarding = connectInstance.create("account-onboarding");
        const accountManagement = connectInstance.create("account-management");

        notificationNode?.replaceChildren(notificationBanner);
        onboardingNode?.replaceChildren(onboarding);
        managementNode?.replaceChildren(accountManagement);

        setComponentState({
          loading: false,
          ready: true,
          error: null,
        });
      } catch (error) {
        console.error("seller payments connect init error:", error);

        if (cancelled) {
          return;
        }

        notificationNode?.replaceChildren();
        onboardingNode?.replaceChildren();
        managementNode?.replaceChildren();

        setComponentState({
          loading: false,
          ready: false,
          error: "Stripe onboarding components could not be loaded.",
        });
      }
    }

    mountComponents();

    return () => {
      cancelled = true;
      notificationNode?.replaceChildren();
      onboardingNode?.replaceChildren();
      managementNode?.replaceChildren();

      if (connectInstance?.logout) {
        connectInstance.logout().catch(() => {});
      }
    };
  }, [canRenderComponents, data.stripePublishableKey]);

  return (
    <VendorManagementShell
      activeItem="payments"
      storeName={data.store.storeName}
      title="Payments"
    >
      <style>{`
        .seller-payments__grid{
          display:grid;
          gap:24px;
        }
        .seller-payments__card{
          background:#ffffff;
          border:1px solid #e5e7eb;
          border-radius:14px;
          padding:20px;
        }
        .seller-payments__title{
          margin:0 0 8px;
          font-size:20px;
          font-weight:700;
        }
        .seller-payments__subtitle{
          margin:0 0 18px;
          font-size:13px;
          color:#6b7280;
          line-height:1.7;
        }
        .seller-payments__notice{
          border:1px solid #d1d5db;
          background:#f9fafb;
          color:#374151;
          border-radius:12px;
          padding:14px 16px;
          font-size:14px;
          line-height:1.7;
        }
        .seller-payments__notice--danger{
          border-color:#fecaca;
          background:#fef2f2;
          color:#b91c1c;
        }
        .seller-payments__notice--success{
          border-color:#a7f3d0;
          background:#ecfdf5;
          color:#047857;
        }
        .seller-payments__description{
          display:grid;
          gap:12px;
        }
        .seller-payments__row{
          display:grid;
          grid-template-columns:220px minmax(0, 1fr);
          gap:16px;
          padding-bottom:12px;
          border-bottom:1px solid #f1f5f9;
        }
        .seller-payments__term{
          font-size:13px;
          color:#6b7280;
          font-weight:700;
        }
        .seller-payments__value{
          font-size:14px;
          line-height:1.7;
          word-break:break-word;
        }
      `}</style>

      <div className="seller-payments__grid">
        <section className="seller-payments__card">
          <h2 className="seller-payments__title">Seller payments setup</h2>
          <p className="seller-payments__subtitle">
            This page keeps Stripe onboarding and account management inside your own
            dashboard. No Stripe-hosted dashboard link is used.
          </p>

          <div className="seller-payments__description">
            <div className="seller-payments__row">
              <div className="seller-payments__term">Seller status</div>
              <div className="seller-payments__value">
                {data.seller?.statusLabel || "Not initialized"}
              </div>
            </div>
            <div className="seller-payments__row">
              <div className="seller-payments__term">Connected account</div>
              <div className="seller-payments__value">
                {data.stripeAccount?.stripeAccountId || "Not created yet"}
              </div>
            </div>
            <div className="seller-payments__row">
              <div className="seller-payments__term">Details submitted</div>
              <div className="seller-payments__value">
                {data.stripeAccount ? String(data.stripeAccount.detailsSubmitted) : "-"}
              </div>
            </div>
            <div className="seller-payments__row">
              <div className="seller-payments__term">Charges enabled</div>
              <div className="seller-payments__value">
                {data.stripeAccount ? String(data.stripeAccount.chargesEnabled) : "-"}
              </div>
            </div>
            <div className="seller-payments__row">
              <div className="seller-payments__term">Payouts enabled</div>
              <div className="seller-payments__value">
                {data.stripeAccount ? String(data.stripeAccount.payoutsEnabled) : "-"}
              </div>
            </div>
            <div className="seller-payments__row">
              <div className="seller-payments__term">Payout schedule</div>
              <div className="seller-payments__value">
                {data.stripeAccount?.payoutSchedule || "-"}
              </div>
            </div>
          </div>
        </section>

        {!data.stripePublishableKey ? (
          <section className="seller-payments__card">
            <div className="seller-payments__notice seller-payments__notice--danger">
              STRIPE_PUBLISHABLE_KEY is missing, so embedded components can’t be rendered.
            </div>
          </section>
        ) : null}

        {!hasStripeAccount ? (
          <section className="seller-payments__card">
            <div className="seller-payments__notice">
              A connected account has not been created yet. Ask an admin to create the
              seller’s Stripe account first.
            </div>
          </section>
        ) : null}

        {componentState.error ? (
          <section className="seller-payments__card">
            <div className="seller-payments__notice seller-payments__notice--danger">
              {componentState.error}
            </div>
          </section>
        ) : null}

        {componentState.loading ? (
          <section className="seller-payments__card">
            <div className="seller-payments__notice">Loading Stripe onboarding…</div>
          </section>
        ) : null}

        {canRenderComponents ? (
          <>
            <section className="seller-payments__card">
              <h2 className="seller-payments__title">Notifications</h2>
              <p className="seller-payments__subtitle">
                Stripe requirement reminders and action prompts appear here.
              </p>
              <div ref={notificationRef} />
            </section>

            <section className="seller-payments__card">
              <h2 className="seller-payments__title">Onboarding</h2>
              <p className="seller-payments__subtitle">
                Complete or refresh account onboarding inside this page.
              </p>
              <div ref={onboardingRef} />
            </section>

            <section className="seller-payments__card">
              <h2 className="seller-payments__title">Account management</h2>
              <p className="seller-payments__subtitle">
                Manage payout details and Stripe account settings without leaving the
                dashboard.
              </p>
              <div ref={managementRef} />
            </section>
          </>
        ) : null}
      </div>
    </VendorManagementShell>
  );
}

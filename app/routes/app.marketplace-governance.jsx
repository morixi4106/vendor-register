import { json } from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const { getMarketplaceGovernanceDashboard } = await import(
    "../services/marketplaceGovernance.server.js"
  );
  return json(await getMarketplaceGovernanceDashboard());
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const governance = await import("../services/marketplaceGovernance.server.js");
  let result;

  switch (intent) {
    case "update_seller_profile":
      result = await governance.upsertSellerComplianceProfile({
        sellerId: String(formData.get("sellerId") || ""),
        values: governance.sellerComplianceProfileFromFormData(formData, {
          admin: true,
        }),
        reviewedBy: "shopify_admin",
      });
      break;
    case "record_agreement":
      {
        const configuration = governance.getMarketplaceGovernanceConfiguration();
        if (
          !configuration.sellerAgreementUrl ||
          !configuration.sellerAgreementDocumentHash ||
          configuration.sellerAgreementVersion === "UNCONFIGURED"
        ) {
          result = { ok: false, reason: "agreement_configuration_incomplete" };
          break;
        }
      result = await governance.recordSellerAgreementAcceptance({
        sellerId: String(formData.get("sellerId") || ""),
        version: configuration.sellerAgreementVersion,
        documentHash: configuration.sellerAgreementDocumentHash,
        acceptedBy: String(formData.get("acceptedBy") || "shopify_admin"),
        source: "ADMIN_RECORDED",
      });
      }
      break;
    case "update_settlement_control":
      result = await governance.upsertSellerSettlementControl({
        sellerId: String(formData.get("sellerId") || ""),
        reviewedBy: "shopify_admin",
        values: {
          salesHold: formData.get("salesHold"),
          payoutHold: formData.get("payoutHold"),
          holdReason: formData.get("holdReason"),
          reserveAmount: formData.get("reserveAmount"),
          futureSetoffEnabled: formData.get("futureSetoffEnabled") === "on",
          directInvoiceBalance: formData.get("directInvoiceBalance"),
        },
      });
      break;
    case "update_product_compliance":
      result = await governance.upsertProductComplianceProfile({
        productId: String(formData.get("productId") || ""),
        values: governance.productComplianceProfileFromFormData(formData, {
          admin: true,
        }),
        reviewedBy: "shopify_admin",
      });
      break;
    case "create_case":
      result = await governance.createMarketplaceOperationalCase(
        Object.fromEntries(formData),
        { actor: "shopify_admin" },
      );
      break;
    case "update_case":
      result = await governance.updateMarketplaceOperationalCase(
        Object.fromEntries(formData),
        { actor: "shopify_admin" },
      );
      break;
    case "create_adjustment":
      result = await governance.createSettlementAdjustment({
        sellerId: String(formData.get("sellerId") || ""),
        caseId: String(formData.get("caseId") || ""),
        adjustmentType: formData.get("adjustmentType"),
        direction: formData.get("direction"),
        amount: formData.get("amount"),
        currencyCode: formData.get("currencyCode"),
        reason: formData.get("reason"),
      });
      break;
    case "apply_adjustment":
      result = await governance.applySettlementAdjustment({
        adjustmentId: String(formData.get("adjustmentId") || ""),
        actor: "shopify_admin",
      });
      break;
    default:
      return json({ ok: false, message: "未対応の操作です。" }, { status: 400 });
  }

  if (!result?.ok) {
    return json(
      { ok: false, message: `保存できませんでした: ${result?.reason || "unknown"}` },
      { status: 400 },
    );
  }
  return json({ ok: true, message: "保存しました。" });
};

const REASON_LABELS = {
  test_store: "テスト店舗",
  seller_not_active: "出店者が販売可能ではない",
  legal_profile_missing: "事業者情報なし",
  legal_profile_not_approved: "事業者情報が未承認",
  entity_type_missing: "事業形態なし",
  legal_name_missing: "法的名称なし",
  legal_country_missing: "国なし",
  legal_address_missing: "住所なし",
  antisocial_declaration_missing: "反社確認なし",
  ship_from_confirmation_missing: "発送元確認なし",
  agreement_version_unconfigured: "契約版が環境変数に未設定",
  agreement_document_hash_unconfigured: "契約本文SHA-256が未設定",
  agreement_url_unconfigured: "契約本文URLが未設定",
  buyer_terms_version_unconfigured: "購入規約版が未設定",
  buyer_terms_url_unconfigured: "購入規約URLが未設定",
  agreement_not_accepted: "現行契約に未同意",
  active_return_address_missing: "有効な返品受取先なし",
  sales_hold: "販売保留",
  product_not_approved: "商品未承認",
  shopify_product_missing: "Shopify未連携",
  product_compliance_missing: "商品コンプライアンス未登録",
  product_compliance_not_approved: "商品コンプライアンス未承認",
  product_condition_missing: "新品・中古区分なし",
  country_of_origin_missing: "原産国なし",
  customs_description_missing: "英語品名なし",
  authenticity_confirmation_missing: "真正性確認なし",
  ip_rights_confirmation_missing: "知財権確認なし",
};

function reasonText(reasons) {
  return (reasons || []).map((reason) => REASON_LABELS[reason] || reason).join("、") || "準備完了";
}

function money(value, currency = "jpy") {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: String(currency || "jpy").toUpperCase(),
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

export default function MarketplaceGovernancePage() {
  const data = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <main className="governance-page">
      <style>{styles}</style>
      <header className="governance-header">
        <div>
          <p className="governance-eyebrow">MARKETPLACE CONTROL</p>
          <h1>販売責任・審査・案件管理</h1>
          <p>
            出店者、商品、契約、精算保留、購入後案件を一つの基準で確認します。自動返金・自動相殺は行いません。
          </p>
        </div>
        <div className={`governance-gate ${data.gateEnabled ? "is-on" : ""}`}>
          販売ゲート {data.gateEnabled ? "ON" : "OFF"}
        </div>
      </header>

      {actionData?.message ? (
        <div className={`governance-notice ${actionData.ok ? "is-success" : "is-error"}`}>
          {actionData.message}
        </div>
      ) : null}

      <section className="governance-summary" aria-label="準備状況">
        <Metric label="出店者準備完了" value={`${data.summary.sellerReadyCount}/${data.summary.sellerCount}`} />
        <Metric label="商品準備完了" value={`${data.summary.productReadyCount}/${data.summary.productCount}`} />
        <Metric label="未完了案件" value={data.summary.openCaseCount} />
        <Metric label="契約版" value={data.agreementVersion} />
      </section>

      {!data.configuration?.ready ? (
        <div className="governance-notice is-error">
          契約設定が不足しています: {reasonText(data.configuration?.reasons)}
        </div>
      ) : null}

      <section className="governance-band">
        <div className="governance-band__heading">
          <div>
            <h2>出店者と契約</h2>
            <p>販売主体を確認し、精算の保留と留保額を管理します。</p>
          </div>
        </div>
        <div className="governance-list">
          {data.sellers.map(({ seller, readiness }) => (
            <details className="governance-row" key={seller.id}>
              <summary>
                <span><strong>{seller.vendor?.storeName || seller.id}</strong>{seller.vendor?.vendorStore?.isTestStore ? " [テスト]" : ""}</span>
                <span className={readiness.ready ? "status-ready" : "status-blocked"}>
                  {readiness.ready ? "準備完了" : reasonText(readiness.reasons)}
                </span>
              </summary>
              <div className="governance-row__body">
                <SellerProfileForm seller={seller} busy={busy} />
                <AgreementForm
                  agreementVersion={data.agreementVersion}
                  agreementUrl={data.configuration?.sellerAgreementUrl}
                  busy={busy}
                  documentHash={data.configuration?.sellerAgreementDocumentHash}
                  seller={seller}
                />
                <SettlementControlForm seller={seller} busy={busy} />
                <Link to={`/app/sellers/${seller.id}`}>本人確認・受取口座の詳細を開く</Link>
              </div>
            </details>
          ))}
        </div>
      </section>

      <section className="governance-band">
        <div className="governance-band__heading">
          <div>
            <h2>商品コンプライアンス</h2>
            <p>直接Shopifyで登録された商品も含め、販売主体・原産国・通関情報・真正性を確認します。</p>
          </div>
        </div>
        <div className="governance-list">
          {data.products.map(({ product, readiness }) => (
            <details className="governance-row" key={product.id}>
              <summary>
                <span><strong>{product.name}</strong> / {product.vendorStore?.storeName || "店舗不明"}</span>
                <span className={readiness.ready ? "status-ready" : "status-blocked"}>
                  {readiness.ready ? "準備完了" : reasonText(readiness.reasons)}
                </span>
              </summary>
              <div className="governance-row__body">
                <ProductComplianceForm product={product} busy={busy} />
              </div>
            </details>
          ))}
        </div>
      </section>

      <section className="governance-band">
        <div className="governance-band__heading">
          <div>
            <h2>購入後案件</h2>
            <p>購入者対応を先に進め、店舗責任と内部精算は証拠確認後に確定します。</p>
          </div>
        </div>
        <CreateCaseForm sellers={data.sellers} busy={busy} />
        <div className="governance-list governance-list--spaced">
          {data.cases.length === 0 ? <p>案件はありません。</p> : null}
          {data.cases.map((entry) => (
            <details className="governance-row" key={entry.id}>
              <summary>
                <span><strong>{entry.caseNumber}</strong> {entry.caseType}: {entry.summary}</span>
                <span>{entry.status} / {money(entry.confirmedSellerLiabilityAmount, entry.currencyCode)}</span>
              </summary>
              <div className="governance-row__body">
                <CaseUpdateForm entry={entry} sellers={data.sellers} busy={busy} />
                <AdjustmentForm entry={entry} busy={busy} />
                {entry.settlementAdjustments.map((adjustment) => (
                  <div className="governance-adjustment" key={adjustment.id}>
                    <span>{adjustment.adjustmentType} / {money(adjustment.amount, adjustment.currencyCode)} / {adjustment.status}</span>
                    {adjustment.status !== "APPLIED" ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="apply_adjustment" />
                        <input type="hidden" name="adjustmentId" value={adjustment.id} />
                        <button disabled={busy} type="submit">承認して台帳へ記録</button>
                      </Form>
                    ) : null}
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      </section>

      <section className="governance-band governance-guide">
        <h2>運用ガイド</h2>
        <ol>
          <li>購入者対応を止めずに案件を作成し、店舗へ必要な事実だけを照会します。</li>
          <li>証拠を確認するまでは責任店舗と相殺額を確定しません。</li>
          <li>責任確定後、未精算売上、留保、将来売上の順で調整し、不足分だけ直接請求します。</li>
          <li>テスト店舗、未承認店舗、未承認商品は本番の販売・出金対象にしません。</li>
          <li>法務文面、税務区分、資金移動業該当性は専門家の最終確認を記録します。</li>
        </ol>
      </section>
    </main>
  );
}

function Metric({ label, value }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function SellerProfileForm({ seller, busy }) {
  const profile = seller.complianceProfile || {};
  return (
    <Form method="post" className="governance-form">
      <input type="hidden" name="intent" value="update_seller_profile" />
      <input type="hidden" name="sellerId" value={seller.id} />
      <label>事業形態<select defaultValue={profile.entityType || "UNSET"} name="entityType"><option value="UNSET">未設定</option><option value="INDIVIDUAL">個人・個人事業</option><option value="CORPORATION">法人</option></select></label>
      <Field label="法的名称" name="legalName" value={profile.legalName} />
      <Field label="代表者" name="representativeName" value={profile.representativeName} />
      <Field label="郵便番号" name="postalCode" value={profile.postalCode} />
      <Field label="国コード" name="countryCode" value={profile.countryCode || "JP"} />
      <Field label="都道府県・州" name="region" value={profile.region} />
      <Field label="市区町村" name="city" value={profile.city} />
      <Field label="住所" name="address1" value={profile.address1} />
      <Field label="建物名" name="address2" value={profile.address2} />
      <Field label="電話番号" name="phone" value={profile.phone} />
      <Field label="適格請求書番号" name="invoiceRegistrationNumber" value={profile.invoiceRegistrationNumber} />
      <label>審査状態<select defaultValue={profile.reviewStatus || "DRAFT"} name="reviewStatus"><option>DRAFT</option><option>PENDING</option><option>APPROVED</option><option>REJECTED</option><option>SUSPENDED</option></select></label>
      <label>審査メモ<textarea defaultValue={profile.reviewNotes || ""} name="reviewNotes" /></label>
      <label className="governance-check"><input defaultChecked={Boolean(profile.antisocialDeclarationAt)} name="antisocialDeclarationConfirmed" type="checkbox" />反社確認</label>
      <label className="governance-check"><input defaultChecked={Boolean(profile.shipFromConfirmedAt)} name="shipFromConfirmed" type="checkbox" />発送元確認</label>
      <label className="governance-check"><input defaultChecked={Boolean(profile.privacyNoticeAcceptedAt)} name="privacyNoticeAccepted" type="checkbox" />個人情報取扱い確認</label>
      <button disabled={busy} type="submit">事業者情報を保存</button>
    </Form>
  );
}

function AgreementForm({
  seller,
  agreementVersion,
  agreementUrl,
  documentHash,
  busy,
}) {
  return (
    <Form method="post" className="governance-form governance-form--compact">
      <input type="hidden" name="intent" value="record_agreement" />
      <input type="hidden" name="sellerId" value={seller.id} />
      <p>契約版: {agreementVersion}</p>
      <p>SHA-256: {documentHash || "未設定"}</p>
      {agreementUrl ? <a href={agreementUrl} rel="noreferrer noopener" target="_blank">契約本文を開く</a> : null}
      <Field label="同意者" name="acceptedBy" value={seller.vendor?.managementEmail} />
      <button disabled={busy || !agreementUrl || !documentHash || agreementVersion === "UNCONFIGURED"} type="submit">契約同意を記録</button>
    </Form>
  );
}

function SettlementControlForm({ seller, busy }) {
  const control = seller.settlementControl || {};
  return (
    <Form method="post" className="governance-form governance-form--compact">
      <input type="hidden" name="intent" value="update_settlement_control" />
      <input type="hidden" name="sellerId" value={seller.id} />
      <label className="governance-check"><input defaultChecked={Boolean(control.salesHold)} name="salesHold" type="checkbox" />販売保留</label>
      <label className="governance-check"><input defaultChecked={Boolean(control.payoutHold)} name="payoutHold" type="checkbox" />出金保留</label>
      <label className="governance-check"><input defaultChecked={Boolean(control.futureSetoffEnabled)} name="futureSetoffEnabled" type="checkbox" />将来売上との相殺を許可</label>
      <Field label="留保額" name="reserveAmount" type="number" value={control.reserveAmount || 0} />
      <Field label="直接請求残高" name="directInvoiceBalance" type="number" value={control.directInvoiceBalance || 0} />
      <Field label="保留理由" name="holdReason" value={control.holdReason} />
      <button disabled={busy} type="submit">精算統制を保存</button>
    </Form>
  );
}

function ProductComplianceForm({ product, busy }) {
  const profile = product.complianceProfile || {};
  return (
    <Form method="post" className="governance-form">
      <input type="hidden" name="intent" value="update_product_compliance" />
      <input type="hidden" name="productId" value={product.id} />
      <label>法的販売者<select defaultValue={profile.legalSellerType || (product.vendorStore?.isPlatformStore ? "PLATFORM" : "VENDOR")} name="legalSellerType"><option value="VENDOR">出店店舗</option><option value="PLATFORM">運営</option></select></label>
      <label>商品状態<select defaultValue={profile.conditionStatus || "UNSET"} name="conditionStatus"><option value="UNSET">未設定</option><option value="NEW">新品</option><option value="USED">中古</option></select></label>
      <Field label="原産国" name="countryOfOriginCode" value={profile.countryOfOriginCode} />
      <Field label="HSコード" name="hsCode" value={profile.hsCode} />
      <Field label="税関向け英語品名" name="customsDescriptionEn" value={profile.customsDescriptionEn} />
      <Field label="規制区分" name="regulatoryCategory" value={profile.regulatoryCategory} />
      <Field label="年齢制限" name="ageRestriction" value={profile.ageRestriction} />
      <label>審査状態<select defaultValue={profile.approvalStatus || "DRAFT"} name="complianceApprovalStatus"><option>DRAFT</option><option>PENDING</option><option>APPROVED</option><option>REJECTED</option><option>HOLD</option></select></label>
      <label>審査メモ<textarea defaultValue={profile.reviewNotes || ""} name="complianceReviewNotes" /></label>
      <label className="governance-check"><input defaultChecked={Boolean(profile.authenticityConfirmedAt)} name="authenticityConfirmed" type="checkbox" />真正性確認</label>
      <label className="governance-check"><input defaultChecked={Boolean(profile.ipRightsConfirmedAt)} name="ipRightsConfirmed" type="checkbox" />知財権確認</label>
      <button disabled={busy} type="submit">商品審査を保存</button>
    </Form>
  );
}

function CreateCaseForm({ sellers, busy }) {
  return (
    <Form method="post" className="governance-form governance-form--case">
      <input type="hidden" name="intent" value="create_case" />
      <label>種別<select name="caseType"><option>WITHDRAWAL</option><option>REFUND</option><option>DELIVERY</option><option>DAMAGE</option><option>COUNTERFEIT</option><option>COMPLIANCE</option><option>CHARGEBACK</option><option>OTHER</option></select></label>
      <label>優先度<select name="priority"><option>NORMAL</option><option>LOW</option><option>HIGH</option><option>CRITICAL</option></select></label>
      <label>対象店舗<select name="sellerId"><option value="">未確定</option>{sellers.map(({ seller }) => <option key={seller.id} value={seller.id}>{seller.vendor?.storeName || seller.id}</option>)}</select></label>
      <Field label="概要" name="summary" />
      <Field label="申告額" name="claimedAmount" type="number" value={0} />
      <Field label="通貨" name="currencyCode" value="jpy" />
      <button disabled={busy} type="submit">案件を作成</button>
    </Form>
  );
}

function CaseUpdateForm({ entry, sellers, busy }) {
  return (
    <Form method="post" className="governance-form">
      <input type="hidden" name="intent" value="update_case" />
      <input type="hidden" name="caseId" value={entry.id} />
      <label>状態<select defaultValue={entry.status} name="status"><option>OPEN</option><option>TRIAGE</option><option>WAITING_FOR_SELLER</option><option>EVIDENCE_REVIEW</option><option>RESPONSIBILITY_CONFIRMED</option><option>ACTION_REQUIRED</option><option>RESOLVED</option><option>CLOSED</option></select></label>
      <label>責任店舗<select defaultValue={entry.responsibilitySellerId || ""} name="responsibilitySellerId"><option value="">未確定</option>{sellers.map(({ seller }) => <option key={seller.id} value={seller.id}>{seller.vendor?.storeName || seller.id}</option>)}</select></label>
      <label>責任判定<select defaultValue={entry.responsibilityStatus} name="responsibilityStatus"><option>UNDETERMINED</option><option>SELLER</option><option>PLATFORM</option><option>SHARED</option><option>EXTERNAL</option></select></label>
      <Field label="店舗責任額" name="confirmedSellerLiabilityAmount" type="number" value={entry.confirmedSellerLiabilityAmount} />
      <Field label="運営責任額" name="platformLiabilityAmount" type="number" value={entry.platformLiabilityAmount} />
      <Field label="解決方法" name="resolutionType" value={entry.resolutionType} />
      <label>記録<textarea defaultValue={entry.resolutionNotes || ""} name="resolutionNotes" /></label>
      <button disabled={busy} type="submit">責任・状態を保存</button>
    </Form>
  );
}

function AdjustmentForm({ entry, busy }) {
  const sellerId = entry.responsibilitySellerId || entry.sellerId || "";
  return (
    <Form method="post" className="governance-form governance-form--compact">
      <input type="hidden" name="intent" value="create_adjustment" />
      <input type="hidden" name="caseId" value={entry.id} />
      <input type="hidden" name="sellerId" value={sellerId} />
      <label>調整種別<select name="adjustmentType"><option>SET_OFF</option><option>RESERVE</option><option>DIRECT_INVOICE</option><option>RELEASE</option></select></label>
      <label>方向<select name="direction"><option value="debit">店舗売上から控除</option><option value="credit">店舗へ加算</option></select></label>
      <Field label="金額" name="amount" type="number" />
      <Field label="通貨" name="currencyCode" value={entry.currencyCode} />
      <Field label="根拠" name="reason" />
      <button disabled={busy || !sellerId} type="submit">調整案を作成</button>
    </Form>
  );
}

function Field({ label, name, value = "", type = "text" }) {
  return <label>{label}<input defaultValue={value ?? ""} min={type === "number" ? 0 : undefined} name={name} type={type} /></label>;
}

const styles = `
  .governance-page{display:grid;gap:24px;padding:24px;background:#f3f4f6;min-height:100%;color:#111827;font-family:Inter,Arial,sans-serif}
  .governance-header,.governance-band{background:#fff;border:1px solid #e5e7eb;padding:24px}
  .governance-header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}
  .governance-header h1,.governance-band h2{margin:0 0 8px}.governance-header p,.governance-band p{margin:0;color:#4b5563;line-height:1.6}
  .governance-eyebrow{font-size:12px;font-weight:700;letter-spacing:0;color:#4b5563}
  .governance-gate{padding:10px 14px;border:1px solid #f59e0b;background:#fffbeb;color:#92400e;font-weight:700}.governance-gate.is-on{border-color:#10b981;background:#ecfdf5;color:#047857}
  .governance-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:#d1d5db;border:1px solid #d1d5db}.governance-summary>div{background:#fff;padding:18px;display:grid;gap:8px}.governance-summary span{font-size:13px;color:#6b7280}.governance-summary strong{font-size:26px}
  .governance-notice{padding:14px 18px;border:1px solid}.governance-notice.is-success{background:#ecfdf5;border-color:#10b981;color:#047857}.governance-notice.is-error{background:#fef2f2;border-color:#ef4444;color:#b91c1c}
  .governance-band__heading{display:flex;justify-content:space-between;gap:16px;margin-bottom:20px}.governance-list{border-top:1px solid #e5e7eb}.governance-list--spaced{margin-top:22px}
  .governance-row{border-bottom:1px solid #e5e7eb}.governance-row summary{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,auto);gap:20px;padding:18px 4px;cursor:pointer}.governance-row__body{display:grid;gap:18px;padding:4px 4px 24px}.status-ready{color:#047857}.status-blocked{color:#b45309;text-align:right}
  .governance-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;padding:18px;background:#f9fafb;border:1px solid #e5e7eb}.governance-form--compact,.governance-form--case{grid-template-columns:repeat(4,minmax(0,1fr))}.governance-form label{display:grid;gap:6px;font-size:13px;font-weight:700}.governance-form input,.governance-form select,.governance-form textarea{width:100%;box-sizing:border-box;min-height:42px;border:1px solid #cbd5e1;background:#fff;padding:9px 10px;font:inherit}.governance-form textarea{min-height:84px}.governance-form button,.governance-adjustment button{min-height:42px;border:0;background:#111827;color:#fff;padding:0 16px;font-weight:700;cursor:pointer}.governance-form button:disabled{opacity:.45;cursor:not-allowed}.governance-check{display:flex!important;grid-template-columns:auto 1fr!important;align-items:center}.governance-check input{width:18px!important;min-height:18px!important}
  .governance-adjustment{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:12px;border:1px solid #d1d5db;background:#fff}.governance-guide ol{margin:16px 0 0;padding-left:22px;line-height:1.8}
  @media(max-width:900px){.governance-header{display:grid}.governance-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.governance-form,.governance-form--compact,.governance-form--case{grid-template-columns:1fr}.governance-row summary{grid-template-columns:1fr}.status-blocked{text-align:left}}
`;

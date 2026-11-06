import { useActionData, useLoaderData, useNavigation } from "react-router";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  Checkbox,
  DataTable,
  FormLayout,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";

import prisma from "../db.server.js";
import {
  MARKETPLACE_OPERATOR_ROLES,
  requireMarketplaceOperator,
} from "../utils/marketplaceOperator.server.js";
import { internationalShippingAction } from "../services/internationalShippingAction.server.js";
import { loadInternationalRunnerAdmin } from "../services/internationalRunnerAdminRead.server.js";
import { internationalErrorResponse } from "../services/internationalRunnerAuthentication.server.js";
import InternationalRunnerPanel from "../components/international/InternationalRunnerPanel.jsx";
import {
  InternationalAdminForm as Form,
  InternationalActionProvider,
} from "../components/international/InternationalAdminForm.jsx";
import { internationalEvidenceVersion } from "../utils/internationalEvidenceVersion.js";
import {
  getInternationalMarketRequirements,
  INTERNATIONAL_MARKET_EVIDENCE_SCOPE,
} from "../utils/internationalMarketReadiness.js";
import { INTERNATIONAL_SERVICE_STATUS } from "../utils/internationalShipping.js";
import { JAPAN_POST_AIR_PACKET_COUNTRY_CODES } from "../utils/japanPostAirPacket.js";

const countryNames = new Intl.DisplayNames(["ja"], { type: "region" });
const countryOptions = JAPAN_POST_AIR_PACKET_COUNTRY_CODES.map((code) => ({
  value: code,
  label: `${countryNames.of(code) || code} (${code})`,
}));
const statusOptions = [
  { value: INTERNATIONAL_SERVICE_STATUS.ACTIVE, label: "受付中" },
  { value: INTERNATIONAL_SERVICE_STATUS.PARTIAL, label: "一部制限" },
  { value: INTERNATIONAL_SERVICE_STATUS.SUSPENDED, label: "停止中" },
  { value: INTERNATIONAL_SERVICE_STATUS.UNKNOWN, label: "未確認" },
];
const confirmationLabels = {
  officialStatusChecked: "公式サイトで受付状況を確認した",
  countryServiceMatched: "対象国と配送サービスの組み合わせを確認した",
  deliveryProfileMatched: "対象商品の配送プロファイルを確認した",
  manualRatesReviewed: "手動送料の迂回経路がないことを確認した",
  freeShippingReviewed: "無料配送の迂回経路がないことを確認した",
  alternateCarrierReviewed: "別Carrier Serviceの迂回経路がないことを確認した",
  alternateProfilesReviewed: "別配送プロファイルの迂回経路がないことを確認した",
  supportLanguageReady: "対象国で通じる問い合わせ言語を用意した",
  returnAddressReady: "対象国向け返送先を用意した",
  complaintsContactReady: "苦情受付先を表示した",
  marketConfigurationReviewed: "Shopify Marketsの対象国設定を確認した",
  currencyConfigurationReviewed: "表示・決済通貨を確認した",
  checkoutAvailabilityReviewed: "対象国でチェックアウト可能なことを確認した",
  hsCodeReady: "HSコードを登録した",
  countryOfOriginReady: "原産国を登録した",
  incotermConfirmed: "DDPまたはDAPを決定した",
  dutiesResponsibilityDisplayed: "関税等の負担者を表示した",
  privacyNoticeReady: "対象国向けプライバシー説明を確認した",
  processorsReviewed: "Shopify・決済・メール等の処理者を確認した",
  transferMechanismReviewed: "国外移転の根拠と説明を確認した",
  withdrawalFunctionVisible: "撤回機能を見つけやすく表示した",
  withdrawalPeriodCovered: "撤回可能期間中ずっと利用できることを確認した",
  acknowledgementEmailReady: "撤回受付メールを用意した",
  contentAndTimestampCaptured: "撤回内容と送信日時をメールへ記録する",
  twoYearGuaranteeDisplayed: "最低2年の法定保証を表示した",
  repairProcedureReady: "修理手順を用意した",
  replacementProcedureReady: "交換手順を用意した",
  priceReductionProcedureReady: "減額手順を用意した",
  refundProcedureReady: "返金手順を用意した",
  vatRegistrationReviewed: "VAT登録の要否を確認した",
  iossDecisionRecorded: "IOSS利用有無を記録した",
  ddpDapDecisionRecorded: "DDP/DAP方針を記録した",
  carrierDutySupportReviewed: "配送業者の関税対応を確認した",
  registrationDecisionRecorded: "包装EPR登録の要否を確認した",
  registrationNumberOrExemptionRecorded: "登録番号または対象外根拠を記録した",
  localRepresentativeDecisionRecorded: "現地代理人の要否を確認した",
  packagingMaterialsRecorded: "包装材種別を記録した",
  reportingScheduleRecorded: "報告・支払周期を記録した",
  lowValueThresholdRecorded: "150ユーロ以下の低額貨物条件を記録した",
  threeEuroItemRuleRecorded: "1 item当たり3ユーロの暫定関税を記録した",
  pidReadinessRecorded: "2026年11月以降のPID対応を記録した",
  cancellationProcedureReady: "取消手順を用意した",
  returnsProcedureReady: "返品手順を用意した",
  statutoryRemediesReady: "法定救済手順を用意した",
};

function statusTone(status) {
  if (status === INTERNATIONAL_SERVICE_STATUS.ACTIVE) return "success";
  if (status === INTERNATIONAL_SERVICE_STATUS.SUSPENDED) return "critical";
  return "warning";
}

function statusLabel(status) {
  return (
    statusOptions.find((option) => option.value === status)?.label || "未確認"
  );
}

function EvidenceCheckbox({ name, checked, onChange }) {
  return (
    <>
      <input type="hidden" name={name} value={checked ? "true" : "false"} />
      <Checkbox
        label={confirmationLabels[name] || name}
        checked={checked}
        onChange={onChange}
      />
    </>
  );
}

export const loader = async ({ request }) => {
  const context = await requireMarketplaceOperator(request, {
    roles: [
      MARKETPLACE_OPERATOR_ROLES.ADMIN,
      MARKETPLACE_OPERATOR_ROLES.COMPLIANCE_REVIEWER,
      MARKETPLACE_OPERATOR_ROLES.RELEASE_MANAGER,
      MARKETPLACE_OPERATOR_ROLES.INCIDENT_COMMANDER,
      MARKETPLACE_OPERATOR_ROLES.RECOVERY_APPROVER,
    ],
  });
  const { session } = context;
  const runner = await loadInternationalRunnerAdmin(prisma, context, request);

  const [rows, evidenceRows, gateState] = await Promise.all([
    prisma.internationalShippingCountryAvailability.findMany({
      orderBy: [{ status: "asc" }, { countryCode: "asc" }],
    }),
    prisma.operationalReadinessAttestation.findMany({
      where: { scopeType: INTERNATIONAL_MARKET_EVIDENCE_SCOPE },
      orderBy: [{ scopeId: "asc" }, { checkKey: "asc" }],
    }),
    prisma.internationalGateSyncState.findUnique({
      where: { shopDomain: session.shop },
      select: {
        mode: true,
        phase: true,
        desiredGeneration: true,
        appliedGeneration: true,
        expectedProductCount: true,
        verifiedProductCount: true,
        protectedAt: true,
      },
    }),
  ]);

  return Response.json(
    { rows, evidenceRows, gateState, runner },
    { headers: { "Cache-Control": "private, no-store" } },
  );
};

export const action = async ({ request }) => {
  try {
    return await internationalShippingAction({ request });
  } catch (error) {
    return internationalErrorResponse(error);
  }
};

export default function InternationalShippingPage() {
  const { rows, evidenceRows, gateState, runner } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [countryCode, setCountryCode] = useState(
    countryOptions[0]?.value || "",
  );
  const [status, setStatus] = useState(INTERNATIONAL_SERVICE_STATUS.UNKNOWN);
  const [sourceUrl, setSourceUrl] = useState("");
  const [note, setNote] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [evidenceHash, setEvidenceHash] = useState("");
  const [deliveryProfileId, setDeliveryProfileId] = useState("");
  const [shippingChecks, setShippingChecks] = useState({});
  const [marketCountryCode, setMarketCountryCode] = useState(
    countryOptions[0]?.value || "",
  );
  const marketRequirements =
    getInternationalMarketRequirements(marketCountryCode);
  const [requirementCode, setRequirementCode] = useState(
    marketRequirements[0]?.code || "",
  );
  const selectedRequirement =
    marketRequirements.find((entry) => entry.code === requirementCode) ||
    marketRequirements[0] ||
    null;
  const [marketSourceUrl, setMarketSourceUrl] = useState(
    selectedRequirement?.sourceUrl || "",
  );
  const [marketEvidenceReference, setMarketEvidenceReference] = useState("");
  const [marketEvidenceHash, setMarketEvidenceHash] = useState("");
  const [marketNote, setMarketNote] = useState("");
  const [marketChecks, setMarketChecks] = useState({});
  const isSubmitting = navigation.state === "submitting";

  function updateShippingCheck(name, checked) {
    setShippingChecks((current) => ({ ...current, [name]: checked }));
  }

  function selectMarketCountry(value) {
    setMarketCountryCode(value);
    const first = getInternationalMarketRequirements(value)[0] || null;
    setRequirementCode(first?.code || "");
    setMarketSourceUrl(first?.sourceUrl || "");
    setMarketChecks({});
  }

  function selectRequirement(value) {
    setRequirementCode(value);
    const requirement = marketRequirements.find(
      (entry) => entry.code === value,
    );
    setMarketSourceUrl(requirement?.sourceUrl || "");
    setMarketChecks({});
  }

  return (
    <InternationalActionProvider
      pending={runner.runs.some(
        (r) =>
          ["QUEUED", "RUNNING", "CLOSING"].includes(r.status) ||
          r.observationRefreshRequestedAt,
      )}
    >
      <Page
        title="国際配送の受付状況"
        subtitle="国別の日本郵便 国際エアパケット受付状況を確認し、確認した国だけ有効にします。"
      >
        <BlockStack gap="400">
          <InternationalRunnerPanel
            data={runner}
            countryOptions={countryOptions}
          />
          <Card>
            <Form method="post">
              <FormLayout>
                <input type="hidden" name="intent" value="saveShipping" />
                <input
                  type="hidden"
                  name="expectedVersion"
                  value={internationalEvidenceVersion(
                    rows.find((row) => row.countryCode === countryCode),
                  )}
                />
                <input
                  type="hidden"
                  name="expectedEvidenceVersions"
                  value={JSON.stringify(
                    Object.fromEntries(
                      [
                        "INTERNATIONAL_CARRIER_SERVICE_STATUS",
                        "INTERNATIONAL_SHOPIFY_DELIVERY_ROUTE_AUDIT",
                      ].map((code) => [
                        code,
                        internationalEvidenceVersion(
                          evidenceRows.find(
                            (row) =>
                              row.scopeId === countryCode &&
                              row.checkKey === code,
                          ),
                        ),
                      ]),
                    ),
                  )}
                />
                <InlineStack gap="300" wrap>
                  <div style={{ minWidth: 0, flex: "1 1 240px" }}>
                    <Select
                      label="国・地域"
                      name="countryCode"
                      options={countryOptions}
                      value={countryCode}
                      onChange={setCountryCode}
                    />
                  </div>
                  <div style={{ minWidth: 0, flex: "1 1 180px" }}>
                    <Select
                      label="受付状況"
                      name="status"
                      options={statusOptions}
                      value={status}
                      onChange={setStatus}
                    />
                  </div>
                </InlineStack>
                <TextField
                  label="確認元URL"
                  name="sourceUrl"
                  type="url"
                  value={sourceUrl}
                  onChange={setSourceUrl}
                  autoComplete="off"
                  helpText="日本郵便など、受付状況を確認したページを記録します。"
                />
                <TextField
                  label="証拠ファイルの保存先またはチケット番号"
                  name="evidenceReference"
                  value={evidenceReference}
                  onChange={setEvidenceReference}
                  autoComplete="off"
                />
                <TextField
                  label="証拠ファイルのSHA-256"
                  name="evidenceHash"
                  value={evidenceHash}
                  onChange={setEvidenceHash}
                  autoComplete="off"
                  helpText="受付中にする場合は64桁のSHA-256が必須です。"
                />
                <TextField
                  label="Shopify配送プロファイルID"
                  name="deliveryProfileId"
                  value={deliveryProfileId}
                  onChange={setDeliveryProfileId}
                  autoComplete="off"
                />
                <BlockStack gap="200">
                  {[
                    "officialStatusChecked",
                    "countryServiceMatched",
                    "deliveryProfileMatched",
                    "manualRatesReviewed",
                    "freeShippingReviewed",
                    "alternateCarrierReviewed",
                    "alternateProfilesReviewed",
                  ].map((name) => (
                    <EvidenceCheckbox
                      key={name}
                      name={name}
                      checked={shippingChecks[name] === true}
                      onChange={(checked) => updateShippingCheck(name, checked)}
                    />
                  ))}
                </BlockStack>
                <TextField
                  label="運用メモ"
                  name="note"
                  multiline={3}
                  value={note}
                  onChange={setNote}
                  autoComplete="off"
                />
                {actionData?.message ? (
                  <Text as="p" tone="success">
                    {actionData.message}
                  </Text>
                ) : null}
                {actionData?.error ? (
                  <Text as="p" tone="critical">
                    {actionData.error}
                  </Text>
                ) : null}
                <Button
                  submit
                  variant="primary"
                  loading={isSubmitting}
                  disabled={!runner.permissions.review}
                >
                  配送証拠と迂回防止確認を保存
                </Button>
              </FormLayout>
            </Form>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Shopify国別販売ゲート
              </Text>
              <Text as="p" tone="subdued">
                {gateState?.mode && gateState.mode !== "DISABLED"
                  ? `同期記録: ${gateState.phase} / 要求世代: ${gateState.desiredGeneration} / 反映世代: ${gateState.appliedGeneration} / 商品: ${gateState.verifiedProductCount}/${gateState.expectedProductCount}`
                  : "未承認"}
              </Text>
              <Form method="post">
                <input
                  type="hidden"
                  name="intent"
                  value="syncInternationalSaleGate"
                />
                <Button
                  submit
                  variant="primary"
                  loading={isSubmitting}
                  disabled={
                    !runner.permissions.release ||
                    !gateState ||
                    gateState.mode === "DISABLED" ||
                    gateState.mode === "STOPPED"
                  }
                >
                  同期を要求
                </Button>
              </Form>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                国別の法務・税務・運用証拠
              </Text>
              <Text as="p" tone="subdued">
                商品証拠とは別に、販売国全体の撤回、保証、VAT・関税、EPR、プライバシー、サポート経路を記録します。
              </Text>
              <Form method="post">
                <FormLayout>
                  <input
                    type="hidden"
                    name="intent"
                    value="saveMarketEvidence"
                  />
                  <input
                    type="hidden"
                    name="expectedVersion"
                    value={internationalEvidenceVersion(
                      evidenceRows.find(
                        (row) =>
                          row.scopeId === marketCountryCode &&
                          row.checkKey === selectedRequirement?.code,
                      ),
                    )}
                  />
                  <InlineStack gap="300" wrap>
                    <div style={{ minWidth: 0, flex: "1 1 240px" }}>
                      <Select
                        label="国・地域"
                        name="countryCode"
                        options={countryOptions}
                        value={marketCountryCode}
                        onChange={selectMarketCountry}
                      />
                    </div>
                    <div style={{ minWidth: 0, flex: "2 1 280px" }}>
                      <Select
                        label="確認項目"
                        name="requirementCode"
                        options={marketRequirements.map((entry) => ({
                          value: entry.code,
                          label: entry.label,
                        }))}
                        value={selectedRequirement?.code || ""}
                        onChange={selectRequirement}
                      />
                    </div>
                  </InlineStack>
                  <TextField
                    label="公式URL"
                    name="officialSourceUrl"
                    type="url"
                    value={marketSourceUrl}
                    onChange={setMarketSourceUrl}
                    autoComplete="off"
                  />
                  <TextField
                    label="証拠ファイルの保存先またはチケット番号"
                    name="evidenceReference"
                    value={marketEvidenceReference}
                    onChange={setMarketEvidenceReference}
                    autoComplete="off"
                  />
                  <TextField
                    label="証拠ファイルのSHA-256"
                    name="evidenceHash"
                    value={marketEvidenceHash}
                    onChange={setMarketEvidenceHash}
                    autoComplete="off"
                  />
                  <BlockStack gap="200">
                    {(selectedRequirement?.confirmations || []).map((name) => (
                      <EvidenceCheckbox
                        key={`${selectedRequirement?.code}-${name}`}
                        name={name}
                        checked={marketChecks[name] === true}
                        onChange={(checked) =>
                          setMarketChecks((current) => ({
                            ...current,
                            [name]: checked,
                          }))
                        }
                      />
                    ))}
                  </BlockStack>
                  <TextField
                    label="確認メモ"
                    name="note"
                    multiline={3}
                    value={marketNote}
                    onChange={setMarketNote}
                    autoComplete="off"
                  />
                  <Button
                    submit
                    variant="primary"
                    loading={isSubmitting}
                    disabled={!runner.permissions.review}
                  >
                    国別証拠を保存
                  </Button>
                </FormLayout>
              </Form>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                確認済みの国・地域
              </Text>
              <Text as="p" tone="subdued">
                未登録、一部制限、停止中、未確認の国にはチェックアウトで配送方法を表示しません。
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "text", "text"]}
                headings={["国・地域", "状況", "確認日時", "確認元"]}
                rows={rows.map((row) => [
                  `${countryNames.of(row.countryCode) || row.countryCode} (${row.countryCode})`,
                  <Badge key={`${row.id}-status`} tone={statusTone(row.status)}>
                    {statusLabel(row.status)}
                  </Badge>,
                  row.checkedAt
                    ? new Date(row.checkedAt).toLocaleString("ja-JP")
                    : "-",
                  row.sourceUrl ? (
                    <a
                      key={`${row.id}-source`}
                      href={row.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      確認元を開く
                    </a>
                  ) : (
                    "-"
                  ),
                ])}
              />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                保存済みの国別証拠
              </Text>
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "text"]}
                headings={["国・地域", "確認項目", "状態", "有効期限", "操作"]}
                rows={evidenceRows.map((row) => [
                  row.scopeId,
                  row.metadataJson?.requirementLabel || row.checkKey,
                  <Badge
                    key={`${row.id}-evidence-status`}
                    tone={row.status === "CONFIRMED" ? "success" : "critical"}
                  >
                    {row.status}
                  </Badge>,
                  row.expiresAt
                    ? new Date(row.expiresAt).toLocaleString("ja-JP")
                    : "-",
                  <Form method="post" key={`${row.id}-revoke`}>
                    <input
                      type="hidden"
                      name="intent"
                      value="revokeMarketEvidence"
                    />
                    <input
                      type="hidden"
                      name="countryCode"
                      value={row.scopeId}
                    />
                    <input
                      type="hidden"
                      name="requirementCode"
                      value={row.checkKey}
                    />
                    <input
                      type="hidden"
                      name="expectedVersion"
                      value={internationalEvidenceVersion(row)}
                    />
                    <Button
                      submit
                      tone="critical"
                      disabled={
                        !runner.permissions.review ||
                        row.status === "REVOKED" ||
                        isSubmitting
                      }
                    >
                      取り消す
                    </Button>
                  </Form>,
                ])}
              />
            </BlockStack>
          </Card>
        </BlockStack>
      </Page>
    </InternationalActionProvider>
  );
}

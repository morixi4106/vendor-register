import { useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Checkbox,
  Select,
  TextField,
  Text,
  InlineStack,
} from "@shopify/polaris";
import {
  RefreshIcon,
  StopCircleIcon,
  DeleteIcon,
  PlayIcon,
} from "@shopify/polaris-icons";
import {
  InternationalAdminForm as Form,
  useInternationalActionResult,
} from "./InternationalAdminForm.jsx";

const labels = {
  QUEUED: "閉鎖検査待ち",
  RUNNING: "検査中",
  CLOSING: "閉鎖要求中",
  PASSED: "検査合格",
  FAILED: "不合格",
  EXPIRED: "期限切れ",
};
const date = (value) => (value ? new Date(value).toLocaleString("ja-JP") : "-");
const hidden = (name, value) => (
  <input key={name} type="hidden" name={name} value={value ?? ""} />
);
export default function InternationalRunnerPanel({
  data,
  countryOptions = [],
}) {
  const { permissions: can } = data;
  const [reference, setReference] = useState("");
  const [hash, setHash] = useState("");
  const [notes, setNotes] = useState("");
  return (
    <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <BlockStack gap="500">
        <section>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" wrap>
              <Text as="h2" variant="headingMd">
                配備と保護
              </Text>
              <Badge tone="warning">一般販売未承認</Badge>
            </InlineStack>
            <Text as="p">
              店舗別の未対応販売経路:{" "}
              {data.surface.status === "CONFIRMED" ? "証拠登録済み" : "要確認"}{" "}
              / 有効期限: {date(data.surface.expiresAt)}
            </Text>
            {can.review ? (
              <Form>
                {hidden("intent", "recordInternationalSurfaceEvidence")}
                {hidden("expectedVersion", data.surface.expectedVersion)}
                {hidden("status", "CONFIRMED")}
                <BlockStack gap="300">
                  <TextField
                    label="販売経路確認の証拠保存先"
                    name="evidenceReference"
                    value={reference}
                    onChange={setReference}
                    autoComplete="off"
                  />
                  <TextField
                    label="証拠のSHA-256"
                    name="evidenceHash"
                    value={hash}
                    onChange={setHash}
                    autoComplete="off"
                  />
                  <TextField
                    label="確認した販売経路と結果"
                    name="notes"
                    value={notes}
                    onChange={setNotes}
                    multiline={3}
                    autoComplete="off"
                  />
                  <Button submit>店舗別証拠を記録</Button>
                </BlockStack>
              </Form>
            ) : null}
            {can.stop ? (
              <Form confirmation="海外販売ゲートの停止を要求しますか？">
                {hidden("intent", "stopInternationalSaleGate")}
                <Button submit tone="critical" icon={StopCircleIcon}>
                  海外販売ゲートを停止
                </Button>
              </Form>
            ) : null}
            {data.deliveries.length === 0 ? (
              <Text as="p" tone="subdued">
                配備記録は未受信です。
              </Text>
            ) : null}
            {data.deliveries.map((row) => (
              <div
                key={row.id}
                style={{ borderTop: "1px solid #d9d9dc", paddingTop: 12 }}
              >
                <BlockStack gap="200">
                  <Text as="p">
                    {row.versionTag} / {row.headSha.slice(0, 12)} /{" "}
                    {row.revokedAt ? "取消済み" : "配備記録受信"}
                  </Text>
                  <Text as="p" tone="subdued">
                    使用期限: {date(row.allowedUseUntil)}
                  </Text>
                  <InlineStack gap="300" wrap>
                    {can.release && !row.revokedAt ? (
                      <Form
                        idempotent
                        confirmation="海外を閉鎖したまま配備検査を開始しますか？"
                      >
                        {hidden("intent", "prepareInternationalDeployment")}
                        {hidden("deliveryId", row.id)}
                        {hidden("expectedDigest", row.receiptDigest)}
                        <Button submit icon={PlayIcon}>
                          閉鎖検査を開始
                        </Button>
                      </Form>
                    ) : null}
                    {can.review && !row.revokedAt ? (
                      <Form confirmation="この配備記録と依存する証拠を取り消しますか？">
                        {hidden("intent", "revokeInternationalProofDelivery")}
                        {hidden("deliveryId", row.id)}
                        {hidden("expectedDigest", row.receiptDigest)}
                        <Button submit tone="critical" icon={DeleteIcon}>
                          配備記録を取消
                        </Button>
                      </Form>
                    ) : null}
                  </InlineStack>
                </BlockStack>
              </div>
            ))}
          </BlockStack>
        </section>
        <section>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              検証履歴
            </Text>
            {!data.runs.length ? (
              <Text as="p" tone="subdued">
                検証履歴はありません。
              </Text>
            ) : null}
            {data.runs.map((row) => (
              <div
                key={row.id}
                style={{ borderTop: "1px solid #d9d9dc", paddingTop: 12 }}
              >
                <BlockStack gap="200">
                  <Text as="p">
                    {row.kind} /{" "}
                    {row.revokedAt
                      ? "取消済み"
                      : labels[row.status] || "未確認"}{" "}
                    / {date(row.createdAt)}
                  </Text>
                  <Text as="p">
                    停止保護:{" "}
                    {row.closureStatus === "CONFIRMED" ? "確認済み" : "未確認"}{" "}
                    / 観測: {date(row.observedAt)}
                  </Text>
                  <Text as="p" tone="subdued">
                    {row.observationRefreshRequestedAt
                      ? "観測待ち"
                      : row.observationExpiresAt &&
                          new Date(row.observationExpiresAt) <= new Date()
                        ? "観測期限切れ"
                        : ""}
                    {row.observationFailureCode
                      ? " / 観測を確認できません。"
                      : ""}
                  </Text>
                  <InlineStack gap="300" wrap>
                    {can.release &&
                    row.kind === "DEPLOYMENT" &&
                    row.status === "PASSED" &&
                    !row.revokedAt &&
                    row.observationFailureCode !==
                      "international_deployment_changed" ? (
                      <Form>
                        {hidden(
                          "intent",
                          "refreshInternationalProofObservation",
                        )}
                        {hidden("runId", row.id)}
                        {hidden("resultDigest", row.resultDigest)}
                        <Button submit icon={RefreshIcon}>
                          観測を更新
                        </Button>
                      </Form>
                    ) : null}
                    {can.review && row.resultDigest && !row.revokedAt ? (
                      <Form confirmation="この検証証拠を取り消しますか？">
                        {hidden("intent", "revokeInternationalProof")}
                        {hidden("runId", row.id)}
                        {hidden("resultDigest", row.resultDigest)}
                        {hidden(
                          "expectedProof",
                          JSON.stringify(row.expectedProof),
                        )}
                        <Button submit tone="critical" icon={DeleteIcon}>
                          証拠を取消
                        </Button>
                      </Form>
                    ) : null}
                  </InlineStack>
                </BlockStack>
              </div>
            ))}
            {data.nextRunCursor ? (
              <a href={`?runCursor=${encodeURIComponent(data.nextRunCursor)}`}>
                以前の検証
              </a>
            ) : null}
          </BlockStack>
        </section>
        <AuthorizationControl data={data} countryOptions={countryOptions} />
      </BlockStack>
    </div>
  );
}
function AuthorizationControl({ data, countryOptions }) {
  const [purpose, setPurpose] = useState("VERIFY");
  const [resumePurpose, setResumePurpose] = useState("VERIFY");
  const [expiresAt, setExpiresAt] = useState("");
  const [products, setProducts] = useState([]);
  const [countries, setCountries] = useState([]);
  const result = useInternationalActionResult();
  const release =
    data.permissions.release &&
    (purpose !== "RESUME" || data.permissions.resume);
  return (
    <section>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          承認範囲
        </Text>
        {!data.capability.ready ? (
          <Badge tone="warning">購入・決済の検証機能は未完成</Badge>
        ) : null}
        <Form>
          {hidden("intent", "previewInternationalAuthorization")}
          {hidden("purpose", purpose)}
          {hidden("resumePurpose", purpose === "RESUME" ? resumePurpose : "")}
          {hidden(
            "verificationKind",
            (purpose === "RESUME" ? resumePurpose : purpose) === "VERIFY"
              ? "NON_FINANCIAL"
              : "",
          )}
          {hidden(
            "scope",
            JSON.stringify(
              (data.products || [])
                .filter((p) => products.includes(p.id))
                .map((p) => ({
                  productId: p.id,
                  shopifyProductId: p.shopifyProductId,
                  countries,
                })),
            ),
          )}
          {hidden("currencies", '["JPY"]')}
          <BlockStack gap="300">
            <Select
              label="承認の用途"
              options={[
                { value: "VERIFY", label: "非課金検証" },
                { value: "SALE", label: "一般販売" },
                { value: "RESUME", label: "停止後の再開" },
              ]}
              value={purpose}
              onChange={setPurpose}
            />
            {purpose === "RESUME" ? (
              <Select
                label="再開する用途"
                options={[
                  { value: "VERIFY", label: "非課金検証" },
                  { value: "SALE", label: "一般販売" },
                ]}
                value={resumePurpose}
                onChange={setResumePurpose}
              />
            ) : null}
            <Text as="p">決済通貨: JPY</Text>
            {data.capability.ready ? (
              <>
                {(data.products || []).map((p) => (
                  <Checkbox
                    key={p.id}
                    label={p.name}
                    checked={products.includes(p.id)}
                    onChange={(checked) =>
                      setProducts((current) =>
                        checked
                          ? [...current, p.id]
                          : current.filter((id) => id !== p.id),
                      )
                    }
                  />
                ))}
                {countryOptions.map((c) => (
                  <Checkbox
                    key={c.value}
                    label={c.label}
                    checked={countries.includes(c.value)}
                    onChange={(checked) =>
                      setCountries((current) =>
                        checked
                          ? [...current, c.value]
                          : current.filter((code) => code !== c.value),
                      )
                    }
                  />
                ))}
              </>
            ) : null}
            <TextField
              label="希望する有効期限"
              type="datetime-local"
              name="expiresAt"
              value={expiresAt}
              onChange={setExpiresAt}
              autoComplete="off"
            />
            <Button submit disabled={!release || !data.capability.ready}>
              承認内容を確認
            </Button>
          </BlockStack>
        </Form>
        {result?.requestId && result?.nonce && data.capability.ready ? (
          <Form confirmation="表示された範囲と期限で承認しますか？">
            {hidden("intent", "confirmInternationalAuthorization")}
            {hidden("requestId", result.requestId)}
            {hidden("nonce", result.nonce)}
            <Text as="p">
              要求: {result.requestId} / 有効期限:{" "}
              {date(result.effectiveExpiresAt || result.expiresAt)}
            </Text>
            <Text as="p">
              用途: {result.preview?.purpose} / 通貨:{" "}
              {result.preview?.currencies?.join(", ")}
            </Text>
            {(result.preview?.scope || []).map((row) => (
              <Text as="p" key={row.productId}>
                {(data.products || []).find((p) => p.id === row.productId)
                  ?.name || row.productId}
                : {row.countries.join(", ")}
              </Text>
            ))}
            <Button submit disabled={!release}>
              承認を確定
            </Button>
          </Form>
        ) : null}
        {data.authorizations.map((row) => (
          <Text as="p" key={row.id}>
            {row.purpose} /{" "}
            {row.revokedAt
              ? "取消済み"
              : row.consumedAt
                ? "受付済み"
                : "未確定"}{" "}
            / {date(row.previewExpiresAt)}
          </Text>
        ))}
      </BlockStack>
    </section>
  );
}

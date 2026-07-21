import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
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
import { authenticate } from "../shopify.server";
import { saveInternationalShippingCountryAvailability } from "../services/internationalShippingAvailability.server.js";
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

function statusTone(status) {
  if (status === INTERNATIONAL_SERVICE_STATUS.ACTIVE) return "success";
  if (status === INTERNATIONAL_SERVICE_STATUS.SUSPENDED) return "critical";
  return "warning";
}

function statusLabel(status) {
  return statusOptions.find((option) => option.value === status)?.label || "未確認";
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const rows = await prisma.internationalShippingCountryAvailability.findMany({
    orderBy: [{ status: "asc" }, { countryCode: "asc" }],
  });

  return json(
    { rows },
    { headers: { "Cache-Control": "private, no-store" } },
  );
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const formData = await request.formData();

  try {
    await saveInternationalShippingCountryAvailability({
      countryCode: formData.get("countryCode"),
      status: formData.get("status"),
      sourceUrl: formData.get("sourceUrl"),
      note: formData.get("note"),
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "保存できませんでした。",
      },
      { status: 400 },
    );
  }

  return redirect("/app/international-shipping");
};

export default function InternationalShippingPage() {
  const { rows } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [countryCode, setCountryCode] = useState(countryOptions[0]?.value || "");
  const [status, setStatus] = useState(INTERNATIONAL_SERVICE_STATUS.UNKNOWN);
  const [sourceUrl, setSourceUrl] = useState("");
  const [note, setNote] = useState("");
  const isSubmitting = navigation.state === "submitting";

  return (
    <Page
      title="国際配送の受付状況"
      subtitle="国別の日本郵便 国際エアパケット受付状況を確認し、確認した国だけ有効にします。"
    >
      <BlockStack gap="400">
        <Card>
          <Form method="post">
            <FormLayout>
              <InlineStack gap="300" wrap>
                <div style={{ minWidth: 280, flex: 1 }}>
                  <Select
                    label="国・地域"
                    name="countryCode"
                    options={countryOptions}
                    value={countryCode}
                    onChange={setCountryCode}
                  />
                </div>
                <div style={{ minWidth: 180, flex: 1 }}>
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
                label="運用メモ"
                name="note"
                multiline={3}
                value={note}
                onChange={setNote}
                autoComplete="off"
              />
              {actionData?.error ? (
                <Text as="p" tone="critical">{actionData.error}</Text>
              ) : null}
              <Button submit variant="primary" loading={isSubmitting}>
                受付状況を保存
              </Button>
            </FormLayout>
          </Form>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">確認済みの国・地域</Text>
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
                row.checkedAt ? new Date(row.checkedAt).toLocaleString("ja-JP") : "-",
                row.sourceUrl ? (
                  <a key={`${row.id}-source`} href={row.sourceUrl} target="_blank" rel="noreferrer">
                    確認元を開く
                  </a>
                ) : "-",
              ])}
            />
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

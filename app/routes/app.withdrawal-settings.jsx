import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  FormLayout,
  InlineGrid,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const MODE_OPTIONS = [
  { label: "運営を単一契約当事者として扱う", value: "PLATFORM_SINGLE_CONTRACT" },
  { label: "店舗ごとに別契約として扱う", value: "SELLER_SEPARATE_CONTRACTS" },
  { label: "出店者の法的役割に応じて分ける", value: "MIXED_BY_SELLER_ROLE" },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const policies = prisma.withdrawalWorkflowPolicy
    ? await prisma.withdrawalWorkflowPolicy.findMany({ orderBy: [{ version: "desc" }] })
    : [];
  return json({ policies });
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const { activateWithdrawalWorkflowPolicy, upsertWithdrawalWorkflowPolicy } =
    await import("../services/withdrawalDirectReturns.server");
  const changedBy = `shopify-admin:${session.shop}`;

  if (intent === "save") {
    const result = await upsertWithdrawalWorkflowPolicy({
      version: Number(formData.get("version")),
      contractMode: String(formData.get("contractMode") || ""),
      termsVersion: String(formData.get("termsVersion") || ""),
      directReturnEnabled: formData.get("directReturnEnabled") === "true",
      notes: String(formData.get("notes") || ""),
      changedBy,
    });
    return json(
      {
        ok: result.ok,
        message: result.ok
          ? "撤回運用方針を保存しました。まだ有効化されていません。"
          : "入力内容を確認してください。",
      },
      { status: result.ok ? 200 : result.status || 400 },
    );
  }
  if (intent === "activate") {
    const result = await activateWithdrawalWorkflowPolicy({
      policyId: String(formData.get("policyId") || ""),
      changedBy,
    });
    return json(
      {
        ok: result.ok,
        message: result.ok
          ? "この方針を新規の撤回申請に適用しました。既存申請は変更されません。"
          : "有効化できませんでした。保存内容を確認してください。",
      },
      { status: result.ok ? 200 : result.status || 400 },
    );
  }
  return json({ ok: false, message: "操作内容が正しくありません。" }, { status: 400 });
};

export default function WithdrawalSettingsPage() {
  const { policies } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [version, setVersion] = useState(
    String(Math.max(2, ...policies.map((policy) => policy.version + 1))),
  );
  const [contractMode, setContractMode] = useState("PLATFORM_SINGLE_CONTRACT");
  const [termsVersion, setTermsVersion] = useState("");
  const [enabled, setEnabled] = useState("true");
  const [notes, setNotes] = useState("");

  return (
    <Page title="撤回運用設定" subtitle="新規申請に適用する店舗別返送の契約方針を管理します。">
      <Layout>
        {actionData?.message ? (
          <Layout.Section>
            <Banner tone={actionData.ok ? "success" : "critical"}><p>{actionData.message}</p></Banner>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">新しい方針</Text>
              <Text as="p" tone="subdued">
                保存だけでは有効になりません。契約形態と規約版を確認後、履歴から明示的に有効化します。
              </Text>
              <Form method="post">
                <input type="hidden" name="intent" value="save" />
                <FormLayout>
                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                    <TextField label="方針バージョン" name="version" type="number" value={version} onChange={setVersion} autoComplete="off" />
                    <Select label="契約形態" name="contractMode" options={MODE_OPTIONS} value={contractMode} onChange={setContractMode} />
                  </InlineGrid>
                  <TextField label="規約版" name="termsVersion" value={termsVersion} onChange={setTermsVersion} placeholder="例: eu-withdrawal-2026-07" autoComplete="off" />
                  <Select label="店舗別返送" name="directReturnEnabled" options={[{ label: "有効化の候補にする", value: "true" }, { label: "無効", value: "false" }]} value={enabled} onChange={setEnabled} />
                  <TextField label="運用メモ" name="notes" value={notes} onChange={setNotes} multiline={3} autoComplete="off" />
                  <Button submit loading={navigation.state !== "idle"}>方針を保存</Button>
                </FormLayout>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">方針履歴</Text>
              {policies.length === 0 ? (
                <Text as="p" tone="subdued">保存済みの方針はありません。</Text>
              ) : policies.map((policy) => (
                <div key={policy.id} style={{ borderTop: "1px solid #e1e3e5", paddingTop: 16 }}>
                  <InlineGrid columns={{ xs: 1, md: 4 }} gap="300">
                    <div><Text as="p" fontWeight="semibold">v{policy.version}</Text><Text as="p" tone="subdued">{modeLabel(policy.contractMode)}</Text></div>
                    <div><Text as="p">規約版</Text><Text as="p" tone="subdued">{policy.termsVersion}</Text></div>
                    <div><Badge tone={policy.active ? "success" : policy.directReturnEnabled ? "attention" : undefined}>{policy.active ? "適用中" : policy.directReturnEnabled ? "有効化待ち" : "無効"}</Badge></div>
                    <Form method="post">
                      <input type="hidden" name="intent" value="activate" />
                      <input type="hidden" name="policyId" value={policy.id} />
                      <Button submit disabled={policy.active || !policy.directReturnEnabled} loading={navigation.state !== "idle"}>この方針を適用</Button>
                    </Form>
                  </InlineGrid>
                </div>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function modeLabel(value) {
  return MODE_OPTIONS.find((option) => option.value === value)?.label || value;
}

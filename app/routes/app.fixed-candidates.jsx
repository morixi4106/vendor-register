import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useState } from "react";
import { Page, Layout, Card, Text, BlockStack, InlineStack } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const candidates = await prisma.fixedReplyCandidate.findMany({
    orderBy: {
      createdAt: "desc",
    },
  });

  return json({ candidates });
};

function formatDate(value) {
  try {
    return new Date(value).toLocaleString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function shortenText(text, max = 60) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return value.slice(0, max) + "...";
}

export default function FixedCandidatesPage() {
  const { candidates } = useLoaderData();
  const [openId, setOpenId] = useState(null);

  return (
    <Page title="固定文候補一覧">
      <Layout>
        <Layout.Section>
          <BlockStack gap="300">
            {candidates.length === 0 ? (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    固定文候補はまだありません
                  </Text>
                  <Text as="p" tone="subdued">
                    問い合わせ一覧から「固定文候補にする」を押すと、ここに溜まります。
                  </Text>
                </BlockStack>
              </Card>
            ) : (
              candidates.map((item) => {
                const isOpen = openId === item.id;

                return (
                  <Card key={item.id}>
                    <div
                      onClick={() => {
                        setOpenId(isOpen ? null : item.id);
                      }}
                      style={{
                        cursor: "pointer",
                      }}
                    >
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h2" variant="bodyMd" fontWeight="semibold">
                            {formatDate(item.createdAt)}
                          </Text>
                          <Text as="span" tone="subdued">
                            {isOpen ? "閉じる" : "開く"}
                          </Text>
                        </InlineStack>

                        <Text as="p" tone="subdued">
                          {shortenText(item.message, 80)}
                        </Text>
                      </BlockStack>
                    </div>

                    {isOpen ? (
                      <div style={{ marginTop: "14px" }}>
                        <BlockStack gap="300">
                          <BlockStack gap="100">
                            <Text as="h3" variant="headingSm">
                              問い合わせ内容
                            </Text>
                            <Text as="p">{item.message}</Text>
                          </BlockStack>

                          <BlockStack gap="100">
                            <Text as="h3" variant="headingSm">
                              返信文候補
                            </Text>
                            <Text as="p">{item.replyText}</Text>
                          </BlockStack>

                          <button
                            onClick={async (e) => {
                              e.stopPropagation();

                              const res = await fetch("/api/adopt-fixed-rule", {
                                method: "POST",
                                headers: {
                                  "Content-Type": "application/json",
                                },
                                body: JSON.stringify({
                                  candidateId: item.id,
                                }),
                              });

                              const data = await res.json();

                              if (data.ok) {
                                alert("本採用した");
                                window.location.reload();
                              } else {
                                alert("本採用に失敗した");
                              }
                            }}
                            style={{
                              marginTop: "4px",
                              padding: "8px 12px",
                              borderRadius: "8px",
                              border: "1px solid #ccc",
                              background: "#eee",
                              cursor: "pointer",
                              width: "fit-content",
                            }}
                          >
                            本採用する
                          </button>
                        </BlockStack>
                      </div>
                    ) : null}
                  </Card>
                );
              })
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, Text, BlockStack } from "@shopify/polaris";
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

export default function FixedCandidatesPage() {
  const { candidates } = useLoaderData();

  return (
    <Page title="固定文候補一覧">
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
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
              candidates.map((item) => (
                <Card key={item.id}>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      作成日時: {formatDate(item.createdAt)}
                    </Text>

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
                      onClick={async () => {
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
                        marginTop: "10px",
                        padding: "8px 12px",
                        borderRadius: "8px",
                        border: "1px solid #ccc",
                        background: "#eee",
                        cursor: "pointer",
                      }}
                    >
                      本採用する
                    </button>
                  </BlockStack>
                </Card>
              ))
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
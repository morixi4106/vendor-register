import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  TextField,
  Select,
  Button,
} from "@shopify/polaris";
import { useState } from "react";

export default function AppIndex() {
  const [ownerName, setOwnerName] = useState("");
  const [storeName, setStoreName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [country, setCountry] = useState("Japan");
  const [category, setCategory] = useState("");
  const [website, setWebsite] = useState("");
  const [note, setNote] = useState("");
  const [ageCheck, setAgeCheck] = useState("私は18歳以上です");

  return (
    <Page title="店舗登録フォーム">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <Text as="h2" variant="headingMd">
                店舗登録
              </Text>

              <TextField
                label="氏名または法人名"
                value={ownerName}
                onChange={setOwnerName}
                autoComplete="name"
              />

              <TextField
                label="店舗名"
                value={storeName}
                onChange={setStoreName}
                autoComplete="organization"
              />

              <TextField
                label="メールアドレス"
                type="email"
                value={email}
                onChange={setEmail}
                autoComplete="email"
              />

              <TextField
                label="電話番号"
                type="tel"
                value={phone}
                onChange={setPhone}
                autoComplete="tel"
              />

              <TextField
                label="所在地"
                value={address}
                onChange={setAddress}
                autoComplete="street-address"
              />

              <Select
                label="国"
                options={[
                  { label: "Japan", value: "Japan" },
                  { label: "United States", value: "United States" },
                  { label: "France", value: "France" },
                  { label: "Korea", value: "Korea" },
                ]}
                value={country}
                onChange={setCountry}
              />

              <TextField
                label="取扱い予定カテゴリ"
                value={category}
                onChange={setCategory}
                autoComplete="off"
              />

              <TextField
                label="Web / SNS"
                value={website}
                onChange={setWebsite}
                autoComplete="url"
              />

              <TextField
                label="備考"
                value={note}
                onChange={setNote}
                multiline={4}
                autoComplete="off"
              />

              <Select
                label="年齢確認"
                options={[
                  { label: "私は18歳以上です", value: "私は18歳以上です" },
                  { label: "私は18歳未満です", value: "私は18歳未満です" },
                ]}
                value={ageCheck}
                onChange={setAgeCheck}
              />

              <Button variant="primary" onClick={() => {}}>
                送信
              </Button>

              <Text as="p" tone="subdued">
                これは表示確認用の仮フォームです。次で保存処理をつなぎます。
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
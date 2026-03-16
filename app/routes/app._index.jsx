import { Page } from "@shopify/polaris";
import { useState } from "react";
import isoCountries from "i18n-iso-countries";
import jaLocale from "i18n-iso-countries/langs/ja.json";

isoCountries.registerLocale(jaLocale);

const countryList = Object.entries(
  isoCountries.getNames("ja", { select: "official" })
)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name, "ja"));

export default function AppIndex() {
  const [ownerName, setOwnerName] = useState("");
  const [storeName, setStoreName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [country, setCountry] = useState("");
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [ageCheck, setAgeCheck] = useState("私は18歳以上です");

  async function handleSubmit(e) {
    e.preventDefault();

    const formData = new FormData();

    formData.append("owner_name", ownerName);
    formData.append("store_name", storeName);
    formData.append("email", email);
    formData.append("phone", phone);
    formData.append("address", address);
    formData.append("country", country);
    formData.append("category", category);
    formData.append("note", note);
    formData.append("age_check", ageCheck);

    const res = await fetch("/api/vendor-register", {
      method: "POST",
      body: formData,
    });

    if (res.redirected) {
      window.location.href = res.url;
    }
  }

  return (
    <Page fullWidth>
      <div className="vendor-form-wrap">
        <h1 className="vendor-form-title">店舗登録（申請）</h1>

        <form onSubmit={handleSubmit}>
          <div className="vendor-form-grid">
            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>氏名または法人名</span>
                <span className="vendor-required">必須</span>
              </label>

              <input
                name="owner_name"
                className="vendor-input"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="山田 太郎 / 株式会社〇〇"
              />
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>店舗名</span>
                <span className="vendor-required">必須</span>
              </label>

              <input
                name="store_name"
                className="vendor-input"
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                placeholder="〇〇ストア"
              />
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>メールアドレス</span>
                <span className="vendor-required">必須</span>
              </label>

              <input
                name="email"
                className="vendor-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="sample@example.com"
              />
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>電話番号</span>
                <span className="vendor-required">必須</span>
              </label>

              <input
                name="phone"
                className="vendor-input"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="09012345678"
              />
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>所在地</span>
                <span className="vendor-required">必須</span>
              </label>

              <input
                name="address"
                className="vendor-input"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="東京都〇〇区"
              />
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>国</span>
                <span className="vendor-required">必須</span>
              </label>

              <select
                name="country"
                className="vendor-country-select"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
              >
                <option value="">国を選択してください</option>

                {countryList.map((c) => (
                  <option key={c.code} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>取扱い予定カテゴリ</span>
                <span className="vendor-required">必須</span>
              </label>

              <input
                name="category"
                className="vendor-input"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="化粧品、雑貨 など"
              />
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>備考</span>
                <span className="vendor-optional">任意</span>
              </label>

              <textarea
                name="note"
                className="vendor-textarea"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="補足事項があればご入力ください"
              />
            </div>

            <div className="vendor-form-row">
              <div className="vendor-form-label">
                <span>年齢確認</span>
                <span className="vendor-required">必須</span>
              </div>

              <div>
                <div className="vendor-radio-group">
                  <div className="vendor-radio-row">
                    <input
                      name="age_check"
                      type="radio"
                      className="vendor-radio-input"
                      value="私は18歳以上です"
                      checked={ageCheck === "私は18歳以上です"}
                      onChange={(e) => setAgeCheck(e.target.value)}
                    />

                    <span className="vendor-radio-label">
                      私は18歳以上です
                    </span>
                  </div>

                  <div className="vendor-radio-row">
                    <input
                      name="age_check"
                      type="radio"
                      className="vendor-radio-input"
                      value="私は18歳未満です"
                      checked={ageCheck === "私は18歳未満です"}
                      onChange={(e) => setAgeCheck(e.target.value)}
                    />

                    <span className="vendor-radio-label">
                      私は18歳未満です
                    </span>
                  </div>
                </div>

                <div className="vendor-age-note">
                  18歳未満の方は、一部商品を取り扱えない場合があります。
                </div>
              </div>
            </div>
          </div>

          <div className="vendor-submit-wrap">
            <button type="submit" className="vendor-submit">
              送信
            </button>
          </div>
        </form>
      </div>
    </Page>
  );
}
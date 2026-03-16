import { Page } from "@shopify/polaris";
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

  function handleSubmit(e) {
    e.preventDefault();
  }

  return (
    <Page fullWidth>
      <style>{`
        .vendor-form-wrap {
          max-width: 1180px;
          margin: 24px auto 48px;
          padding: 0 24px;
        }

        .vendor-form-title {
          font-size: 56px;
          font-weight: 800;
          line-height: 1.2;
          color: #111;
          margin: 0 0 40px;
          letter-spacing: 0;
        }

        .vendor-form-grid {
          display: grid;
          gap: 34px;
        }

        .vendor-form-row {
          display: grid;
          grid-template-columns: 300px 1fr;
          gap: 34px;
          align-items: start;
        }

        .vendor-form-label {
          display: flex;
          align-items: center;
          gap: 16px;
          padding-top: 18px;
          color: #111;
          font-size: 34px;
          font-weight: 800;
          line-height: 1.45;
          word-break: keep-all;
        }

        .vendor-required,
        .vendor-optional {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 80px;
          height: 44px;
          padding: 0 18px;
          border-radius: 12px;
          color: #fff;
          font-size: 18px;
          font-weight: 800;
          line-height: 1;
          flex: 0 0 auto;
        }

        .vendor-required {
          background: #c91c1c;
        }

        .vendor-optional {
          background: #8b8b8b;
        }

        .vendor-input,
        .vendor-textarea,
        .vendor-country-select {
          width: 100%;
          box-sizing: border-box;
          border: 1px solid #d8d8d8;
          border-radius: 12px;
          background: #fff;
          color: #111;
          padding: 0 28px;
          font-size: 26px;
          line-height: 1.4;
          box-shadow: none;
        }

        .vendor-input,
        .vendor-country-select {
          height: 92px;
        }

        .vendor-textarea {
          min-height: 230px;
          padding-top: 22px;
          padding-bottom: 22px;
          resize: vertical;
        }

        .vendor-input::placeholder,
        .vendor-textarea::placeholder {
          color: #b8b8b8;
        }

        .vendor-input:focus,
        .vendor-textarea:focus,
        .vendor-country-select:focus {
          outline: none;
          border-color: #111;
        }

        .vendor-radio-group {
          border: 1px solid #d8d8d8;
          border-radius: 12px;
          background: #fff;
          padding: 22px 28px;
        }

        .vendor-radio-row {
          display: flex;
          align-items: center;
          gap: 18px;
          margin-bottom: 20px;
        }

        .vendor-radio-row:last-child {
          margin-bottom: 0;
        }

        .vendor-radio-input {
          width: 28px;
          height: 28px;
          margin: 0;
          flex: 0 0 auto;
        }

        .vendor-radio-label {
          font-size: 28px;
          font-weight: 500;
          line-height: 1.6;
          color: #111;
        }

        .vendor-age-note {
          margin-top: 16px;
          border: 1px solid #ecd08d;
          background: #fff7e4;
          border-radius: 12px;
          padding: 18px 22px;
          color: #8a6200;
          font-size: 16px;
          line-height: 1.8;
        }

        .vendor-submit-wrap {
          margin-top: 18px;
          text-align: center;
        }

        .vendor-submit {
          min-width: 320px;
          height: 88px;
          padding: 0 40px;
          border: none;
          border-radius: 999px;
          background: #111;
          color: #fff;
          font-size: 30px;
          font-weight: 800;
          line-height: 1;
          cursor: pointer;
          transition: opacity 0.2s ease;
        }

        .vendor-submit:hover {
          opacity: 0.92;
        }

        .vendor-helper {
          margin-top: 18px;
          text-align: center;
          color: #666;
          font-size: 15px;
          line-height: 1.7;
        }

        @media screen and (max-width: 1024px) {
          .vendor-form-title {
            font-size: 42px;
          }

          .vendor-form-row {
            grid-template-columns: 1fr;
            gap: 14px;
          }

          .vendor-form-label {
            font-size: 24px;
            padding-top: 0;
          }

          .vendor-input,
          .vendor-country-select {
            height: 68px;
            font-size: 18px;
            padding: 0 18px;
          }

          .vendor-textarea {
            min-height: 160px;
            font-size: 18px;
            padding: 16px 18px;
          }

          .vendor-radio-group {
            padding: 16px 18px;
          }

          .vendor-radio-label {
            font-size: 18px;
          }

          .vendor-submit {
            min-width: 220px;
            height: 60px;
            font-size: 22px;
          }
        }
      `}</style>

      <div className="vendor-form-wrap">
        <h1 className="vendor-form-title">店舗登録（申請）</h1>

        <form onSubmit={handleSubmit}>
          <div className="vendor-form-grid">
            <div className="vendor-form-row">
              <label htmlFor="owner_name" className="vendor-form-label">
                <span>氏名または法人名</span>
                <span className="vendor-required">必須</span>
              </label>
              <div>
                <input
                  id="owner_name"
                  name="owner_name"
                  type="text"
                  className="vendor-input"
                  placeholder="山田 太郎 / 株式会社〇〇"
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                />
              </div>
            </div>

            <div className="vendor-form-row">
              <label htmlFor="store_name" className="vendor-form-label">
                <span>店舗名</span>
                <span className="vendor-required">必須</span>
              </label>
              <div>
                <input
                  id="store_name"
                  name="store_name"
                  type="text"
                  className="vendor-input"
                  placeholder="〇〇ストア"
                  value={storeName}
                  onChange={(e) => setStoreName(e.target.value)}
                />
              </div>
            </div>

            <div className="vendor-form-row">
              <label htmlFor="email" className="vendor-form-label">
                <span>メールアドレス</span>
                <span className="vendor-required">必須</span>
              </label>
              <div>
                <input
                  id="email"
                  name="email"
                  type="email"
                  className="vendor-input"
                  placeholder="sample@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </div>

            <div className="vendor-form-row">
              <label htmlFor="phone" className="vendor-form-label">
                <span>電話番号</span>
                <span className="vendor-required">必須</span>
              </label>
              <div>
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  className="vendor-input"
                  placeholder="09012345678"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
            </div>

            <div className="vendor-form-row">
              <label htmlFor="address" className="vendor-form-label">
                <span>所在地</span>
                <span className="vendor-required">必須</span>
              </label>
              <div>
                <input
                  id="address"
                  name="address"
                  type="text"
                  className="vendor-input"
                  placeholder="東京都〇〇区〇〇"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </div>
            </div>

            <div className="vendor-form-row">
              <label htmlFor="country" className="vendor-form-label">
                <span>国</span>
                <span className="vendor-required">必須</span>
              </label>
              <div>
                <select
                  id="country"
                  name="country"
                  className="vendor-country-select"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                >
                  <option value="Japan">Japan</option>
                  <option value="United States">United States</option>
                  <option value="France">France</option>
                  <option value="Korea">Korea</option>
                </select>
              </div>
            </div>

            <div className="vendor-form-row">
              <label htmlFor="category" className="vendor-form-label">
                <span>取扱い予定カテゴリ</span>
                <span className="vendor-required">必須</span>
              </label>
              <div>
                <input
                  id="category"
                  name="category"
                  type="text"
                  className="vendor-input"
                  placeholder="化粧品、雑貨 など"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
              </div>
            </div>

            <div className="vendor-form-row">
              <label htmlFor="website" className="vendor-form-label">
                <span>Web / SNS</span>
                <span className="vendor-optional">任意</span>
              </label>
              <div>
                <input
                  id="website"
                  name="website"
                  type="text"
                  className="vendor-input"
                  placeholder="https://example.com"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>
            </div>

            <div className="vendor-form-row">
              <label htmlFor="note" className="vendor-form-label">
                <span>備考</span>
                <span className="vendor-optional">任意</span>
              </label>
              <div>
                <textarea
                  id="note"
                  name="note"
                  className="vendor-textarea"
                  placeholder="補足事項があればご入力ください"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
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
                      id="age_check_over"
                      name="age_check"
                      type="radio"
                      className="vendor-radio-input"
                      value="私は18歳以上です"
                      checked={ageCheck === "私は18歳以上です"}
                      onChange={(e) => setAgeCheck(e.target.value)}
                    />
                    <label htmlFor="age_check_over" className="vendor-radio-label">
                      私は18歳以上です
                    </label>
                  </div>

                  <div className="vendor-radio-row">
                    <input
                      id="age_check_under"
                      name="age_check"
                      type="radio"
                      className="vendor-radio-input"
                      value="私は18歳未満です"
                      checked={ageCheck === "私は18歳未満です"}
                      onChange={(e) => setAgeCheck(e.target.value)}
                    />
                    <label htmlFor="age_check_under" className="vendor-radio-label">
                      私は18歳未満です
                    </label>
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

          <div className="vendor-helper">
            これは表示確認用の仮フォームです。次で保存処理をつなぎます。
          </div>
        </form>
      </div>
    </Page>
  );
}
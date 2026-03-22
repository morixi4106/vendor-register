import { useState } from "react";
import isoCountries from "i18n-iso-countries";
import jaLocale from "i18n-iso-countries/langs/ja.json";

isoCountries.registerLocale(jaLocale);

const countryList = Object.entries(
  isoCountries.getNames("ja", { select: "official" })
)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name, "ja"));

export default function Register() {
  const [ownerName, setOwnerName] = useState("");
  const [storeName, setStoreName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [country, setCountry] = useState("");
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [ageCheck, setAgeCheck] = useState("私は18歳以上です");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit() {
    if (isSubmitting) return;
    setIsSubmitting(true);

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

    try {
      const res = await fetch(
        "https://vendor-register-pbjl.onrender.com/api/vendor-register",
        {
          method: "POST",
          body: formData,
        }
      );

      const text = await res.text();
      let data = null;

      try {
        data = JSON.parse(text);
      } catch (_) {
        data = null;
      }

      console.log("vendor-register response status:", res.status);
      console.log("vendor-register response body:", text);

      if (!res.ok || !data?.ok) {
        alert(
          data?.errors?.map((e) => e.message).join("\n") ||
            text ||
            "送信に失敗しました。"
        );
        setIsSubmitting(false);
        return;
      }

      alert("保存成功");
      window.top.location.href =
        "https://oja-immanuel-bacchus.myshopify.com/pages/%E5%BA%97%E8%88%97%E5%90%91%E3%81%91%E5%88%A9%E7%94%A8%E8%A6%8F%E7%B4%84";
    } catch (err) {
      console.error(err);
      alert("通信エラーが発生しました。");
      setIsSubmitting(false);
    }
  }

  return (
    <div className="register-page">
      <style>{`
        .register-page{
          min-height:100vh;
          background:#fff;
          color:#111;
        }

        .register-header-outer{
          max-width:1540px;
          margin:0 auto;
          padding:24px 40px 0;
        }

        .register-header{
          min-height:118px;
          display:flex;
          align-items:flex-start;
        }

        .vendor-logo-link{
          display:inline-flex;
          align-items:flex-start;
          text-decoration:none;
          line-height:0;
        }

        .vendor-logo{
          width:154px;
          height:auto;
          display:block;
        }

        .register-main{
          max-width:1540px;
          margin:0 auto;
          padding:8px 40px 72px;
        }

        .vendor-form-wrap{
          max-width:1180px;
          margin:0 auto;
        }

        .vendor-title{
          margin:0 0 44px;
          text-align:center;
          font-size:56px;
          line-height:1.15;
          font-weight:800;
          color:#111;
        }

        .vendor-form-grid{
          display:grid;
          gap:34px;
        }

        .vendor-form-row{
          display:grid;
          grid-template-columns:minmax(220px,280px) 1fr;
          gap:34px;
          align-items:start;
        }

        .vendor-form-label{
          display:flex;
          flex-wrap:wrap;
          align-items:center;
          gap:16px;
          padding-top:18px;
          color:#111;
          font-size:30px;
          font-weight:800;
        }

        .vendor-form-label span:first-child{
          word-break:break-word;
        }

        .vendor-required,
        .vendor-optional{
          display:inline-flex;
          align-items:center;
          justify-content:center;
          min-width:80px;
          height:44px;
          padding:0 18px;
          border-radius:12px;
          color:#fff;
          font-size:18px;
          font-weight:800;
        }

        .vendor-required{
          background:#c91c1c;
        }

        .vendor-optional{
          background:#8b8b8b;
        }

        .vendor-input,
        .vendor-textarea,
        .vendor-country-select{
          width:100%;
          box-sizing:border-box;
          border:1px solid #d8d8d8;
          border-radius:12px;
          background:#fff;
          color:#111;
          padding:0 28px;
          font-size:22px;
        }

        .vendor-input,
        .vendor-country-select{
          height:92px;
        }

        .vendor-textarea{
          min-height:230px;
          padding-top:22px;
          padding-bottom:22px;
          resize:vertical;
        }

        .vendor-radio-group{
          border:1px solid #d8d8d8;
          border-radius:12px;
          background:#fff;
          padding:22px 28px;
        }

        .vendor-radio-row{
          display:flex;
          align-items:center;
          gap:18px;
          margin-bottom:20px;
        }

        .vendor-radio-row:last-child{
          margin-bottom:0;
        }

        .vendor-radio-input{
          width:28px;
          height:28px;
        }

        .vendor-radio-label{
          font-size:28px;
        }

        .vendor-age-note{
          margin-top:16px;
          border:1px solid #ecd08d;
          background:#fff7e4;
          border-radius:12px;
          padding:18px 22px;
          color:#8a6200;
          font-size:16px;
        }

        .vendor-submit-wrap{
          margin-top:20px;
          text-align:center;
        }

        .vendor-submit{
          min-width:320px;
          height:88px;
          border:none;
          border-radius:999px;
          background:#111;
          color:#fff;
          font-size:26px;
          font-weight:800;
          cursor:pointer;
        }

        .vendor-submit:hover{
          opacity:0.92;
        }

        .vendor-submit:disabled{
          opacity:0.7;
          cursor:not-allowed;
        }

        @media screen and (max-width:768px){
          .register-header-outer{
            padding:20px 16px 0;
          }

          .register-header{
            min-height:auto;
          }

          .vendor-logo{
            width:120px;
          }

          .register-main{
            padding:20px 16px 48px;
          }

          .vendor-title{
            font-size:32px;
            margin-bottom:28px;
          }

          .vendor-form-row{
            grid-template-columns:1fr;
            gap:10px;
          }

          .vendor-form-label{
            font-size:20px;
            padding-top:0;
          }

          .vendor-input,
          .vendor-country-select{
            height:56px;
            font-size:18px;
            padding:0 16px;
          }

          .vendor-textarea{
            min-height:140px;
            font-size:18px;
            padding:14px 16px;
          }

          .vendor-radio-label{
            font-size:18px;
          }

          .vendor-submit{
            width:100%;
            height:60px;
            font-size:22px;
          }
        }
      `}</style>

      <div className="register-header-outer">
        <header className="register-header">
          <a
            className="vendor-logo-link"
            href="https://oja-immanuel-bacchus.myshopify.com/"
            aria-label="トップページへ戻る"
          >
            <img
              className="vendor-logo"
              src="/logo.png"
              alt="Oja Immanuel Bacchus"
            />
          </a>
        </header>
      </div>

      <main className="register-main">
        <div className="vendor-form-wrap">
          <h1 className="vendor-title">店舗登録</h1>

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

            <div className="vendor-submit-wrap">
              <button
                type="button"
                className="vendor-submit"
                disabled={isSubmitting}
                onClick={handleSubmit}
              >
                {isSubmitting ? "送信中..." : "送信"}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
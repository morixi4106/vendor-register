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

        .vendor-form-wrap{
          max-width:1180px;
          margin:24px auto 48px;
          padding:0 24px;
        }

        .vendor-form-title{
          font-size:56px;
          font-weight:800;
          line-height:1.2;
          color:#111;
          margin:0 0 40px;
        }

        .vendor-form-grid{
          display:grid;
          gap:34px;
        }

        .vendor-form-row{
          display:grid;
          grid-template-columns:300px 1fr;
          gap:34px;
          align-items:start;
        }

        .vendor-form-label{
          display:flex;
          align-items:center;
          gap:16px;
          padding-top:18px;
          color:#111;
          font-size:30px;
          font-weight:800;
          line-height:1.45;
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

        .vendor-input:focus,
        .vendor-textarea:focus,
        .vendor-country-select:focus{
          outline:none;
          border-color:#111;
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
          color:#111;
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
          margin-top:18px;
          text-align:center;
        }

        .vendor-submit{
          min-width:320px;
          height:88px;
          padding:0 40px;
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


        /* スマホUI */

        @media screen and (max-width:768px){

          .vendor-form-title{
            font-size:32px;
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
                className="vendor-input"
                value={ownerName}
                onChange={(e)=>setOwnerName(e.target.value)}
                placeholder="山田 太郎 / 株式会社〇〇"
              />
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>店舗名</span>
                <span className="vendor-required">必須</span>
              </label>
              <input
                className="vendor-input"
                value={storeName}
                onChange={(e)=>setStoreName(e.target.value)}
                placeholder="〇〇ストア"
              />
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>メールアドレス</span>
                <span className="vendor-required">必須</span>
              </label>
              <input
                className="vendor-input"
                value={email}
                onChange={(e)=>setEmail(e.target.value)}
                placeholder="sample@example.com"
              />
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>電話番号</span>
                <span className="vendor-required">必須</span>
              </label>
              <input
                className="vendor-input"
                value={phone}
                onChange={(e)=>setPhone(e.target.value)}
                placeholder="09012345678"
              />
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>所在地</span>
                <span className="vendor-required">必須</span>
              </label>
              <input
                className="vendor-input"
                value={address}
                onChange={(e)=>setAddress(e.target.value)}
                placeholder="東京都〇〇区〇〇"
              />
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>国</span>
                <span className="vendor-required">必須</span>
              </label>
              <select
                className="vendor-country-select"
                value={country}
                onChange={(e)=>setCountry(e.target.value)}
              >
                <option>Japan</option>
                <option>United States</option>
                <option>France</option>
                <option>Korea</option>
              </select>
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>取扱い予定カテゴリ</span>
                <span className="vendor-required">必須</span>
              </label>
              <input
                className="vendor-input"
                value={category}
                onChange={(e)=>setCategory(e.target.value)}
                placeholder="化粧品、雑貨 など"
              />
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>Web / SNS</span>
                <span className="vendor-optional">任意</span>
              </label>
              <input
                className="vendor-input"
                value={website}
                onChange={(e)=>setWebsite(e.target.value)}
                placeholder="https://example.com"
              />
            </div>

            <div className="vendor-form-row">
              <label className="vendor-form-label">
                <span>備考</span>
                <span className="vendor-optional">任意</span>
              </label>
              <textarea
                className="vendor-textarea"
                value={note}
                onChange={(e)=>setNote(e.target.value)}
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
                      type="radio"
                      className="vendor-radio-input"
                      value="私は18歳以上です"
                      checked={ageCheck==="私は18歳以上です"}
                      onChange={(e)=>setAgeCheck(e.target.value)}
                    />
                    <span className="vendor-radio-label">
                      私は18歳以上です
                    </span>
                  </div>

                  <div className="vendor-radio-row">
                    <input
                      type="radio"
                      className="vendor-radio-input"
                      value="私は18歳未満です"
                      checked={ageCheck==="私は18歳未満です"}
                      onChange={(e)=>setAgeCheck(e.target.value)}
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
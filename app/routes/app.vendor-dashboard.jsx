export default function VendorDashboard() {
  const summaryCards = [
    { title: "本日の売上", value: "¥128,400", sub: "+12.4%" },
    { title: "未発送注文", value: "18", sub: "要対応 4件" },
    { title: "公開中商品", value: "146", sub: "申請中 7件" },
    { title: "広告経由売上", value: "¥32,800", sub: "ROAS 4.3" },
  ];

  const orders = [
    { id: "O-240321", customer: "山田 花子", total: "¥6,560", status: "発送待ち", age: "12分前" },
    { id: "O-240320", customer: "株式会社 Lumiere", total: "¥12,400", status: "対応要", age: "27分前" },
    { id: "O-240319", customer: "佐藤 健", total: "¥3,280", status: "発送済み", age: "1時間前" },
    { id: "O-240318", customer: "高橋 美咲", total: "¥9,940", status: "発送待ち", age: "2時間前" },
  ];

  const products = [
    {
      name: "NEOBEAUTE 薬用リンクルケアアイシート",
      sku: "SKU-001",
      stock: 124,
      price: "¥3,280",
      sales: 312,
      status: "販売中",
      approval: "承認済み",
    },
    {
      name: "CICA モイスチャーローション",
      sku: "SKU-002",
      stock: 18,
      price: "¥2,480",
      sales: 190,
      status: "在庫少",
      approval: "承認済み",
    },
    {
      name: "ビタミン美容液 30ml",
      sku: "SKU-003",
      stock: 0,
      price: "¥4,200",
      sales: 88,
      status: "在庫切れ",
      approval: "申請中",
    },
    {
      name: "クレンジングバーム",
      sku: "SKU-004",
      stock: 63,
      price: "¥2,980",
      sales: 141,
      status: "販売中",
      approval: "要確認",
    },
  ];

  function badgeClass(text) {
    if (text === "対応要" || text === "在庫切れ") return "dash-badge dash-badge-red";
    if (text === "発送待ち" || text === "在庫少" || text === "申請中") return "dash-badge dash-badge-yellow";
    if (text === "承認済み" || text === "販売中" || text === "発送済み") return "dash-badge dash-badge-green";
    return "dash-badge dash-badge-gray";
  }

  return (
    <div className="vendor-dashboard">
      <style>{`
        .vendor-dashboard{
          min-height:100vh;
          background:#f3f4f6;
          color:#111827;
          font-family:Arial, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
        }

        .dash-topbar{
          background:#ffffff;
          border-bottom:1px solid #e5e7eb;
          padding:16px 24px;
        }

        .dash-topbar-inner{
          max-width:1400px;
          margin:0 auto;
          display:flex;
          align-items:center;
          gap:16px;
          flex-wrap:wrap;
        }

        .dash-brand{
          min-width:260px;
        }

        .dash-brand-sub{
          font-size:12px;
          color:#6b7280;
          margin:0 0 4px;
        }

        .dash-brand-title{
          font-size:24px;
          font-weight:700;
          margin:0;
        }

        .dash-search{
          flex:1;
          min-width:260px;
        }

        .dash-search input{
          width:100%;
          height:44px;
          border:1px solid #d1d5db;
          border-radius:8px;
          padding:0 14px;
          font-size:14px;
          background:#f9fafb;
          box-sizing:border-box;
        }

        .dash-top-actions{
          display:flex;
          gap:10px;
          flex-wrap:wrap;
        }

        .dash-btn{
          height:44px;
          padding:0 16px;
          border-radius:8px;
          border:1px solid #d1d5db;
          background:#fff;
          font-size:14px;
          font-weight:700;
          cursor:pointer;
        }

        .dash-btn-primary{
          background:#111827;
          color:#fff;
          border-color:#111827;
        }

        .dash-layout{
          max-width:1400px;
          margin:0 auto;
          padding:24px;
          display:grid;
          grid-template-columns:260px 1fr;
          gap:24px;
        }

        .dash-sidebar{
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:14px;
          padding:14px;
          height:fit-content;
        }

        .dash-menu{
          display:grid;
          gap:8px;
        }

        .dash-menu-item{
          display:block;
          width:100%;
          text-align:left;
          padding:12px 14px;
          border:none;
          border-radius:10px;
          background:#fff;
          font-size:14px;
          font-weight:700;
          cursor:pointer;
        }

        .dash-menu-item-active{
          background:#111827;
          color:#fff;
        }

        .dash-main{
          display:grid;
          gap:24px;
        }

        .dash-cards{
          display:grid;
          grid-template-columns:repeat(4, minmax(0, 1fr));
          gap:16px;
        }

        .dash-card{
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:14px;
          padding:18px;
        }

        .dash-card-title{
          font-size:13px;
          color:#6b7280;
          margin:0 0 10px;
        }

        .dash-card-value{
          font-size:30px;
          font-weight:700;
          margin:0 0 8px;
        }

        .dash-card-sub{
          font-size:13px;
          color:#6b7280;
          margin:0;
        }

        .dash-grid-2{
          display:grid;
          grid-template-columns:2fr 1fr;
          gap:24px;
        }

        .dash-section-title{
          font-size:20px;
          font-weight:700;
          margin:0 0 8px;
        }

        .dash-section-sub{
          font-size:13px;
          color:#6b7280;
          margin:0 0 18px;
        }

        .dash-chart{
          height:260px;
          display:flex;
          align-items:end;
          gap:14px;
          padding-top:10px;
        }

        .dash-bar-wrap{
          flex:1;
          text-align:center;
        }

        .dash-bar{
          width:100%;
          border-radius:10px 10px 0 0;
          background:#111827;
          min-height:20px;
        }

        .dash-bar-label{
          font-size:12px;
          color:#6b7280;
          margin-top:8px;
        }

        .dash-health-list{
          display:grid;
          gap:14px;
        }

        .dash-health-row{
          display:grid;
          gap:6px;
        }

        .dash-health-head{
          display:flex;
          justify-content:space-between;
          font-size:14px;
        }

        .dash-progress{
          width:100%;
          height:10px;
          background:#e5e7eb;
          border-radius:999px;
          overflow:hidden;
        }

        .dash-progress-fill{
          height:100%;
          background:#111827;
        }

        .dash-alert{
          margin-top:18px;
          border:1px solid #f59e0b;
          background:#fffbeb;
          color:#92400e;
          border-radius:12px;
          padding:14px;
          font-size:14px;
          line-height:1.7;
        }

        .dash-grid-3{
          display:grid;
          grid-template-columns:2fr 1fr;
          gap:24px;
        }

        .dash-order-list{
          display:grid;
          gap:12px;
        }

        .dash-order-item{
          border:1px solid #e5e7eb;
          border-radius:12px;
          padding:14px;
          display:flex;
          justify-content:space-between;
          gap:16px;
          align-items:center;
          flex-wrap:wrap;
        }

        .dash-order-main{
          display:grid;
          gap:6px;
        }

        .dash-order-title{
          font-size:15px;
          font-weight:700;
          margin:0;
        }

        .dash-order-sub{
          font-size:13px;
          color:#6b7280;
          margin:0;
        }

        .dash-quick-list{
          display:grid;
          gap:10px;
        }

        .dash-quick-btn{
          width:100%;
          text-align:left;
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:12px;
          padding:14px;
          font-size:14px;
          font-weight:700;
          cursor:pointer;
        }

        .dash-table-wrap{
          overflow-x:auto;
        }

        .dash-table{
          width:100%;
          min-width:860px;
          border-collapse:collapse;
        }

        .dash-table th{
          text-align:left;
          font-size:13px;
          color:#6b7280;
          border-bottom:1px solid #e5e7eb;
          padding:12px 10px;
        }

        .dash-table td{
          padding:16px 10px;
          border-bottom:1px solid #f1f5f9;
          font-size:14px;
          vertical-align:middle;
        }

        .dash-product-name{
          font-weight:700;
        }

        .dash-badge{
          display:inline-block;
          padding:5px 10px;
          border-radius:999px;
          font-size:12px;
          font-weight:700;
          line-height:1;
          border:1px solid transparent;
        }

        .dash-badge-red{
          background:#fef2f2;
          color:#b91c1c;
          border-color:#fecaca;
        }

        .dash-badge-yellow{
          background:#fffbeb;
          color:#92400e;
          border-color:#fde68a;
        }

        .dash-badge-green{
          background:#ecfdf5;
          color:#047857;
          border-color:#a7f3d0;
        }

        .dash-badge-gray{
          background:#f3f4f6;
          color:#374151;
          border-color:#d1d5db;
        }

        @media (max-width: 1100px){
          .dash-layout{
            grid-template-columns:1fr;
          }

          .dash-cards{
            grid-template-columns:repeat(2, minmax(0, 1fr));
          }

          .dash-grid-2,
          .dash-grid-3{
            grid-template-columns:1fr;
          }
        }

        @media (max-width: 700px){
          .dash-cards{
            grid-template-columns:1fr;
          }

          .dash-topbar,
          .dash-layout{
            padding:16px;
          }

          .dash-brand-title{
            font-size:20px;
          }
        }
      `}</style>

      <div className="dash-topbar">
        <div className="dash-topbar-inner">
          <div className="dash-brand">
            <p className="dash-brand-sub">店舗管理</p>
            <h1 className="dash-brand-title">Oja Immanuel Bacchus Seller Center</h1>
          </div>

          <div className="dash-search">
            <input type="text" placeholder="商品名・SKU・注文番号で検索" />
          </div>

          <div className="dash-top-actions">
            <button className="dash-btn">通知</button>
            <button className="dash-btn dash-btn-primary">商品を追加</button>
          </div>
        </div>
      </div>

      <div className="dash-layout">
        <aside className="dash-sidebar">
          <div className="dash-menu">
            <button className="dash-menu-item dash-menu-item-active">ダッシュボード</button>
            <button className="dash-menu-item">注文管理</button>
            <button className="dash-menu-item">商品管理</button>
            <button className="dash-menu-item">在庫</button>
            <button className="dash-menu-item">広告</button>
            <button className="dash-menu-item">設定</button>
          </div>
        </aside>

        <main className="dash-main">
          <section className="dash-cards">
            {summaryCards.map((card) => (
              <div className="dash-card" key={card.title}>
                <p className="dash-card-title">{card.title}</p>
                <p className="dash-card-value">{card.value}</p>
                <p className="dash-card-sub">{card.sub}</p>
              </div>
            ))}
          </section>

          <section className="dash-grid-2">
            <div className="dash-card">
              <h2 className="dash-section-title">売上推移</h2>
              <p className="dash-section-sub">過去7日間の注文売上</p>

              <div className="dash-chart">
                {[
                  { label: "月", height: 120 },
                  { label: "火", height: 150 },
                  { label: "水", height: 100 },
                  { label: "木", height: 180 },
                  { label: "金", height: 220 },
                  { label: "土", height: 190 },
                  { label: "日", height: 130 },
                ].map((item) => (
                  <div className="dash-bar-wrap" key={item.label}>
                    <div className="dash-bar" style={{ height: `${item.height}px` }} />
                    <div className="dash-bar-label">{item.label}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="dash-card">
              <h2 className="dash-section-title">アカウント健全性</h2>
              <p className="dash-section-sub">警告が出る前に確認</p>

              <div className="dash-health-list">
                <div className="dash-health-row">
                  <div className="dash-health-head">
                    <span>注文不良率</span>
                    <span>0.4%</span>
                  </div>
                  <div className="dash-progress">
                    <div className="dash-progress-fill" style={{ width: "18%" }} />
                  </div>
                </div>

                <div className="dash-health-row">
                  <div className="dash-health-head">
                    <span>出荷遅延率</span>
                    <span>1.2%</span>
                  </div>
                  <div className="dash-progress">
                    <div className="dash-progress-fill" style={{ width: "28%" }} />
                  </div>
                </div>

                <div className="dash-health-row">
                  <div className="dash-health-head">
                    <span>キャンセル率</span>
                    <span>0.3%</span>
                  </div>
                  <div className="dash-progress">
                    <div className="dash-progress-fill" style={{ width: "12%" }} />
                  </div>
                </div>
              </div>

              <div className="dash-alert">
                在庫切れ商品が1件あります。  
                機会損失を防ぐため、在庫補充か公開停止の確認を先にやる想定です。
              </div>
            </div>
          </section>

          <section className="dash-grid-3">
            <div className="dash-card">
              <h2 className="dash-section-title">優先対応の注文</h2>
              <p className="dash-section-sub">未発送・要確認の注文を上に表示</p>

              <div className="dash-order-list">
                {orders.map((order) => (
                  <div className="dash-order-item" key={order.id}>
                    <div className="dash-order-main">
                      <p className="dash-order-title">
                        {order.id} <span className={badgeClass(order.status)}>{order.status}</span>
                      </p>
                      <p className="dash-order-sub">
                        {order.customer} ・ {order.total}
                      </p>
                    </div>
                    <div className="dash-order-sub">{order.age}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="dash-card">
              <h2 className="dash-section-title">すぐ使う操作</h2>
              <p className="dash-section-sub">店舗運営でよく使う導線</p>

              <div className="dash-quick-list">
                <button className="dash-quick-btn">商品申請を確認</button>
                <button className="dash-quick-btn">在庫切れ商品を確認</button>
                <button className="dash-quick-btn">広告キャンペーンを見る</button>
                <button className="dash-quick-btn">配送設定を編集</button>
              </div>
            </div>
          </section>

          <section className="dash-card">
            <h2 className="dash-section-title">商品管理</h2>
            <p className="dash-section-sub">
              Amazonっぽく一覧性を重視したテーブル。あとで実データ接続しやすい形。
            </p>

            <div className="dash-table-wrap">
              <table className="dash-table">
                <thead>
                  <tr>
                    <th>商品</th>
                    <th>SKU</th>
                    <th>在庫</th>
                    <th>価格</th>
                    <th>販売数</th>
                    <th>状態</th>
                    <th>申請</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => (
                    <tr key={product.sku}>
                      <td className="dash-product-name">{product.name}</td>
                      <td>{product.sku}</td>
                      <td>{product.stock}</td>
                      <td>{product.price}</td>
                      <td>{product.sales}</td>
                      <td><span className={badgeClass(product.status)}>{product.status}</span></td>
                      <td><span className={badgeClass(product.approval)}>{product.approval}</span></td>
                      <td><button className="dash-btn">詳細</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
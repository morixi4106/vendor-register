import { useMemo, useState } from "react";

export default function VendorDashboard() {
  const [query, setQuery] = useState("");

  const summaryCards = [
    { title: "本日の売上", value: "¥128,400", sub: "+12.4%" },
    { title: "月の売上", value: "¥2,843,900", sub: "今月 842点" },
    { title: "未発送注文", value: "18", sub: "要対応 4件" },
    { title: "公開中商品", value: "146", sub: "申請中 7件" },
  ];

  const priorityOrders = [
    {
      id: "O-240321",
      customer: "山田 花子",
      product: "NEOBEAUTE 薬用リンクルケアアイシート",
      quantity: 2,
      total: "¥6,560",
      status: "発送待ち",
      age: "12分前",
      tracking: "JP-4839-2201",
      countdownHours: 64,
    },
    {
      id: "O-240320",
      customer: "株式会社 Lumiere",
      product: "CICA モイスチャーローション",
      quantity: 5,
      total: "¥12,400",
      status: "対応要",
      age: "27分前",
      tracking: "JP-4839-2202",
      countdownHours: 21,
    },
    {
      id: "O-240319",
      customer: "佐藤 健",
      product: "ビタミン美容液 30ml",
      quantity: 1,
      total: "¥4,200",
      status: "発送済み",
      age: "1時間前",
      tracking: "JP-4839-2203",
      countdownHours: 0,
    },
    {
      id: "O-240318",
      customer: "高橋 美咲",
      product: "クレンジングバーム",
      quantity: 3,
      total: "¥8,940",
      status: "発送待ち",
      age: "2時間前",
      tracking: "JP-4839-2204",
      countdownHours: 48,
    },
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
      tracking: "JP-TRACK-001",
    },
    {
      name: "CICA モイスチャーローション",
      sku: "SKU-002",
      stock: 18,
      price: "¥2,480",
      sales: 190,
      status: "在庫少",
      approval: "承認済み",
      tracking: "JP-TRACK-002",
    },
    {
      name: "ビタミン美容液 30ml",
      sku: "SKU-003",
      stock: 0,
      price: "¥4,200",
      sales: 88,
      status: "在庫切れ",
      approval: "申請中",
      tracking: "JP-TRACK-003",
    },
    {
      name: "クレンジングバーム",
      sku: "SKU-004",
      stock: 63,
      price: "¥2,980",
      sales: 141,
      status: "販売中",
      approval: "要確認",
      tracking: "JP-TRACK-004",
    },
  ];

  const monthlySales = [
    { name: "NEOBEAUTE 薬用リンクルケアアイシート", quantity: 312 },
    { name: "CICA モイスチャーローション", quantity: 190 },
    { name: "ビタミン美容液 30ml", quantity: 88 },
    { name: "クレンジングバーム", quantity: 141 },
  ];

  const filteredProducts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;

    return products.filter((product) => {
      return (
        product.name.toLowerCase().includes(q) ||
        product.sku.toLowerCase().includes(q) ||
        product.tracking.toLowerCase().includes(q)
      );
    });
  }, [query]);

  function badgeClass(text) {
    if (text === "対応要" || text === "在庫切れ") return "dash-badge dash-badge-red";
    if (text === "発送待ち" || text === "在庫少" || text === "申請中") return "dash-badge dash-badge-yellow";
    if (text === "承認済み" || text === "販売中" || text === "発送済み") return "dash-badge dash-badge-green";
    return "dash-badge dash-badge-gray";
  }

  function formatCountdown(hours) {
    if (hours <= 0) return "期限処理済み";
    const totalHours = Math.floor(hours);
    const days = Math.floor(totalHours / 24);
    const restHours = totalHours % 24;
    return `${days}日 ${restHours}時間`;
  }

  function exportMonthlyPdf() {
    window.print();
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

        .dash-btn:hover{
          background:#f9fafb;
        }

        .dash-btn-primary{
          background:#111827;
          color:#fff;
          border-color:#111827;
        }

        .dash-btn-primary:hover{
          background:#1f2937;
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

        .dash-menu-item:hover{
          background:#f9fafb;
        }

        .dash-menu-item-active{
          background:#111827;
          color:#fff;
        }

        .dash-menu-item-active:hover{
          background:#111827;
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
          box-sizing:border-box;
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

        .dash-grid-3{
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
          flex:1;
          min-width:260px;
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

        .dash-order-right{
          min-width:170px;
          text-align:right;
        }

        .dash-countdown-label{
          font-size:12px;
          color:#6b7280;
        }

        .dash-countdown-box{
          display:inline-block;
          margin-top:6px;
          padding:8px 12px;
          border-radius:12px;
          font-size:14px;
          font-weight:700;
          background:#f3f4f6;
          color:#374151;
        }

        .dash-countdown-box.is-danger{
          background:#fef2f2;
          color:#b91c1c;
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

        .dash-quick-btn:hover{
          background:#f9fafb;
        }

        .dash-pdf-box{
          border:1px solid #e5e7eb;
          background:#f9fafb;
          border-radius:12px;
          padding:14px;
          font-size:14px;
          line-height:1.8;
        }

        .dash-monthly-list{
          margin-top:14px;
          border-top:1px solid #e5e7eb;
          padding-top:14px;
        }

        .dash-monthly-row{
          display:flex;
          justify-content:space-between;
          gap:12px;
          padding:8px 0;
          font-size:14px;
          border-bottom:1px solid #f1f5f9;
        }

        .dash-table-wrap{
          overflow-x:auto;
        }

        .dash-table{
          width:100%;
          min-width:980px;
          border-collapse:collapse;
        }

        .dash-table th{
          text-align:left;
          font-size:13px;
          color:#6b7280;
          border-bottom:1px solid #e5e7eb;
          padding:12px 10px;
          white-space:nowrap;
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
          white-space:nowrap;
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

        @media print{
          .dash-sidebar,
          .dash-top-actions,
          .dash-search,
          .dash-quick-list,
          .dash-btn,
          .dash-order-right .dash-order-sub{
            display:none !important;
          }

          .dash-layout{
            grid-template-columns:1fr;
            padding:0;
          }

          .dash-topbar{
            padding:0 0 20px;
            border-bottom:none;
          }

          .vendor-dashboard{
            background:#fff;
          }

          .dash-card{
            break-inside:avoid;
          }
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

          .dash-order-right{
            width:100%;
            text-align:left;
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
            <input
              type="text"
              placeholder="商品名・SKU・追跡番号で検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="dash-top-actions">
            <button className="dash-btn">通知</button>
            <button className="dash-btn dash-btn-primary" onClick={exportMonthlyPdf}>
              月次PDF出力
            </button>
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
              <h2 className="dash-section-title">優先対応の商品・注文</h2>
              <p className="dash-section-sub">72時間以内に対応したい注文を上に表示</p>

              <div className="dash-order-list">
                {priorityOrders.map((order) => (
                  <div className="dash-order-item" key={order.id}>
                    <div className="dash-order-main">
                      <p className="dash-order-title">
                        {order.id} <span className={badgeClass(order.status)}>{order.status}</span>
                      </p>
                      <p className="dash-order-sub">
                        {order.customer} ・ {order.product} ・ {order.quantity}点 ・ {order.total}
                      </p>
                      <p className="dash-order-sub">追跡番号: {order.tracking}</p>
                    </div>

                    <div className="dash-order-right">
                      <div className="dash-countdown-label">72時間カウントダウン</div>
                      <div
                        className={`dash-countdown-box ${
                          order.countdownHours <= 24 ? "is-danger" : ""
                        }`}
                      >
                        {formatCountdown(order.countdownHours)}
                      </div>
                      <p className="dash-order-sub" style={{ marginTop: "8px" }}>
                        {order.age}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="dash-card">
              <h2 className="dash-section-title">月次PDF出力</h2>
              <p className="dash-section-sub">月の売れた商品名と個数をワンボタンで出力</p>

              <div className="dash-pdf-box">
                <div><strong>出力内容</strong></div>
                <div>・月の売上合計</div>
                <div>・商品名ごとの販売数</div>
                <div>・注文ごとの追跡番号</div>
              </div>

              <div className="dash-monthly-list">
                {monthlySales.map((item) => (
                  <div className="dash-monthly-row" key={item.name}>
                    <span>{item.name}</span>
                    <strong>{item.quantity}個</strong>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: "14px" }}>
                <button className="dash-btn dash-btn-primary" onClick={exportMonthlyPdf}>
                  月次売上PDFを出力
                </button>
              </div>
            </div>
          </section>

          <section className="dash-card">
            <h2 className="dash-section-title">商品管理</h2>
            <p className="dash-section-sub">
              一覧性重視のテーブル。追跡番号も同じ画面で確認できる形。
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
                    <th>追跡番号</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.map((product) => (
                    <tr key={product.sku}>
                      <td className="dash-product-name">{product.name}</td>
                      <td>{product.sku}</td>
                      <td>{product.stock}</td>
                      <td>{product.price}</td>
                      <td>{product.sales}</td>
                      <td>
                        <span className={badgeClass(product.status)}>{product.status}</span>
                      </td>
                      <td>
                        <span className={badgeClass(product.approval)}>{product.approval}</span>
                      </td>
                      <td>{product.tracking}</td>
                      <td>
                        <button className="dash-btn">詳細</button>
                      </td>
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
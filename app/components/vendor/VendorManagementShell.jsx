import { Link } from "@remix-run/react";
import VendorPageHeader from "./VendorPageHeader";
import VendorSidebar from "./VendorSidebar";

const DEFAULT_ACTIONS = (
  <>
    <Link className="vendor-shell__button" to="/vendor/products/new">
      新規商品登録
    </Link>
    <Link className="vendor-shell__button vendor-shell__button--primary" to="/vendor/reports/monthly">
      月次PDF出力
    </Link>
  </>
);

export default function VendorManagementShell({
  activeItem,
  storeName,
  title = "店舗管理",
  search = null,
  actions = null,
  children,
}) {
  return (
    <div className="vendor-shell">
      <style>{`
        .vendor-shell{
          min-height:100vh;
          background:#f3f4f6;
          color:#111827;
          font-family:Arial, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
        }
        .vendor-shell__topbar{
          background:#ffffff;
          border-bottom:1px solid #e5e7eb;
          padding:16px 24px;
        }
        .vendor-shell__topbar-inner{
          max-width:1400px;
          margin:0 auto;
          display:flex;
          align-items:center;
          gap:16px;
          flex-wrap:wrap;
        }
        .vendor-shell__brand{
          min-width:240px;
        }
        .vendor-shell__brand-sub{
          margin:0 0 4px;
          font-size:12px;
          color:#6b7280;
        }
        .vendor-shell__brand-title{
          margin:0;
          font-size:24px;
          font-weight:700;
        }
        .vendor-shell__search-slot{
          flex:1;
          min-width:260px;
        }
        .vendor-shell__action-slot{
          display:flex;
          gap:10px;
          flex-wrap:wrap;
          align-items:center;
        }
        .vendor-shell__layout{
          max-width:1400px;
          margin:0 auto;
          padding:24px;
          display:grid;
          grid-template-columns:260px minmax(0, 1fr);
          gap:24px;
        }
        .vendor-shell__sidebar{
          background:#ffffff;
          border:1px solid #e5e7eb;
          border-radius:14px;
          padding:14px;
          height:fit-content;
        }
        .vendor-shell__nav{
          display:grid;
          gap:8px;
        }
        .vendor-shell__nav-link{
          display:block;
          width:100%;
          box-sizing:border-box;
          padding:12px 14px;
          border-radius:10px;
          text-decoration:none;
          color:#111827;
          font-size:14px;
          font-weight:700;
          background:#ffffff;
        }
        .vendor-shell__nav-link:hover{
          background:#f9fafb;
        }
        .vendor-shell__nav-link.is-active{
          background:#111827;
          color:#ffffff;
        }
        .vendor-shell__main{
          display:grid;
          gap:24px;
          min-width:0;
        }
        .vendor-shell__button{
          display:inline-flex;
          align-items:center;
          justify-content:center;
          min-height:44px;
          padding:0 16px;
          border-radius:10px;
          border:1px solid #d1d5db;
          background:#ffffff;
          color:#111827;
          font-size:14px;
          font-weight:700;
          text-decoration:none;
          cursor:pointer;
          box-sizing:border-box;
        }
        .vendor-shell__button:hover{
          background:#f9fafb;
        }
        .vendor-shell__button--primary{
          background:#111827;
          border-color:#111827;
          color:#ffffff;
        }
        .vendor-shell__button--primary:hover{
          background:#1f2937;
        }
        .vendor-shell__button--danger{
          color:#b91c1c;
        }
        .vendor-shell__search-input,
        .vendor-shell__search-form input,
        .vendor-shell__search-form select,
        .vendor-shell__search-form button,
        .vendor-shell__month-input{
          min-height:44px;
          box-sizing:border-box;
          border-radius:10px;
          font-size:14px;
        }
        .vendor-shell__search-input,
        .vendor-shell__search-form input,
        .vendor-shell__search-form select,
        .vendor-shell__month-input{
          width:100%;
          padding:0 14px;
          border:1px solid #d1d5db;
          background:#f9fafb;
        }
        .vendor-shell__search-form{
          display:flex;
          flex-wrap:wrap;
          gap:10px;
          align-items:center;
        }
        .vendor-shell__search-form > *{
          flex:1 1 180px;
        }
        .vendor-shell__search-form .vendor-shell__button,
        .vendor-shell__search-form a{
          flex:0 0 auto;
        }
        .vendor-card{
          background:#ffffff;
          border:1px solid #e5e7eb;
          border-radius:14px;
          padding:20px;
          box-sizing:border-box;
        }
        .vendor-card-grid{
          display:grid;
          grid-template-columns:repeat(4, minmax(0, 1fr));
          gap:16px;
        }
        .vendor-grid{
          display:grid;
          grid-template-columns:repeat(2, minmax(0, 1fr));
          gap:24px;
        }
        .vendor-stack{
          display:grid;
          gap:24px;
        }
        .vendor-stat-title{
          margin:0 0 10px;
          font-size:13px;
          color:#6b7280;
        }
        .vendor-stat-value{
          margin:0 0 8px;
          font-size:30px;
          font-weight:700;
        }
        .vendor-stat-sub{
          margin:0;
          font-size:13px;
          color:#6b7280;
        }
        .vendor-section-title{
          margin:0 0 8px;
          font-size:20px;
          font-weight:700;
        }
        .vendor-section-subtitle{
          margin:0 0 18px;
          font-size:13px;
          color:#6b7280;
          line-height:1.7;
        }
        .vendor-note{
          border:1px solid #dbeafe;
          background:#eff6ff;
          color:#1d4ed8;
          border-radius:12px;
          padding:14px 16px;
          font-size:14px;
          line-height:1.7;
        }
        .vendor-placeholder{
          border:1px dashed #d1d5db;
          background:#f9fafb;
          color:#4b5563;
          border-radius:12px;
          padding:18px;
          font-size:14px;
          line-height:1.8;
        }
        .vendor-list{
          margin:0;
          padding-left:18px;
          display:grid;
          gap:10px;
        }
        .vendor-table-wrap{
          overflow-x:auto;
        }
        .vendor-table{
          width:100%;
          min-width:980px;
          border-collapse:collapse;
        }
        .vendor-table th{
          padding:12px 10px;
          border-bottom:1px solid #e5e7eb;
          font-size:13px;
          color:#6b7280;
          text-align:left;
          white-space:nowrap;
        }
        .vendor-table td{
          padding:16px 10px;
          border-bottom:1px solid #f1f5f9;
          vertical-align:middle;
          font-size:14px;
        }
        .vendor-table__name{
          font-weight:700;
        }
        .vendor-table__meta{
          display:block;
          margin-top:4px;
          font-size:12px;
          color:#6b7280;
        }
        .vendor-table-actions{
          display:flex;
          gap:8px;
          align-items:center;
          flex-wrap:wrap;
        }
        .vendor-inline-form{
          margin:0;
        }
        .vendor-shell__badge{
          display:inline-flex;
          align-items:center;
          padding:5px 10px;
          border-radius:999px;
          border:1px solid transparent;
          font-size:12px;
          font-weight:700;
          line-height:1;
          white-space:nowrap;
        }
        .vendor-shell__badge--danger{
          background:#fef2f2;
          color:#b91c1c;
          border-color:#fecaca;
        }
        .vendor-shell__badge--warning{
          background:#fffbeb;
          color:#92400e;
          border-color:#fde68a;
        }
        .vendor-shell__badge--success{
          background:#ecfdf5;
          color:#047857;
          border-color:#a7f3d0;
        }
        .vendor-shell__badge--neutral{
          background:#f3f4f6;
          color:#374151;
          border-color:#d1d5db;
        }
        .vendor-description-list{
          display:grid;
          gap:12px;
        }
        .vendor-description-row{
          display:grid;
          grid-template-columns:180px minmax(0, 1fr);
          gap:16px;
          align-items:flex-start;
          padding-bottom:12px;
          border-bottom:1px solid #f1f5f9;
        }
        .vendor-description-term{
          font-size:13px;
          color:#6b7280;
          font-weight:700;
        }
        .vendor-description-value{
          font-size:14px;
          line-height:1.7;
          word-break:break-word;
        }
        .vendor-helper-text{
          margin-top:10px;
          font-size:12px;
          color:#6b7280;
          line-height:1.7;
        }
        .vendor-actions-row{
          display:flex;
          gap:10px;
          flex-wrap:wrap;
        }
        @media print{
          .vendor-shell__sidebar,
          .vendor-shell__action-slot,
          .vendor-shell__search-slot,
          .vendor-shell__button{
            display:none !important;
          }
          .vendor-shell__layout{
            grid-template-columns:1fr;
            padding:0;
          }
          .vendor-shell__topbar{
            padding:0 0 20px;
            border-bottom:none;
          }
          .vendor-shell{
            background:#ffffff;
          }
        }
        @media (max-width: 1100px){
          .vendor-shell__layout{
            grid-template-columns:1fr;
          }
          .vendor-card-grid,
          .vendor-grid{
            grid-template-columns:repeat(2, minmax(0, 1fr));
          }
        }
        @media (max-width: 760px){
          .vendor-shell__topbar,
          .vendor-shell__layout{
            padding:16px;
          }
          .vendor-card-grid,
          .vendor-grid,
          .vendor-description-row{
            grid-template-columns:1fr;
          }
          .vendor-shell__brand-title{
            font-size:20px;
          }
        }
      `}</style>

      <VendorPageHeader
        title={title}
        storeName={storeName}
        search={search}
        actions={actions || DEFAULT_ACTIONS}
      />

      <div className="vendor-shell__layout">
        <VendorSidebar activeItem={activeItem} />
        <main className="vendor-shell__main">{children}</main>
      </div>
    </div>
  );
}

export const productionReadinessStyles = `
        .readiness-page{
          display:grid;
          gap:24px;
          padding:24px;
          background:#f3f4f6;
          min-height:100%;
          color:#111827;
        }
        .readiness-card{
          background:#fff;
          border:1px solid #e5e7eb;
          border-radius:16px;
          padding:22px;
        }
        .readiness-header{
          display:flex;
          justify-content:space-between;
          gap:16px;
          align-items:flex-start;
          flex-wrap:wrap;
        }
        .readiness-title{
          margin:0 0 8px;
          font-size:28px;
          line-height:1.25;
        }
        .readiness-subtitle{
          margin:0;
          color:#4b5563;
          line-height:1.7;
        }
        .readiness-badge{
          display:inline-flex;
          align-items:center;
          min-height:36px;
          padding:0 14px;
          border-radius:999px;
          font-weight:800;
          border:1px solid;
          white-space:nowrap;
        }
        .readiness-badge--pass{
          color:#047857;
          background:#ecfdf5;
          border-color:#a7f3d0;
        }
        .readiness-badge--fail{
          color:#b91c1c;
          background:#fef2f2;
          border-color:#fecaca;
        }
        .readiness-next-step{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:18px;
          border:2px solid #111827;
          background:#fff;
        }
        .readiness-next-step__body{
          display:grid;
          gap:6px;
          max-width:760px;
        }
        .readiness-next-step__eyebrow{
          margin:0;
          color:#4b5563;
          font-size:13px;
          font-weight:800;
        }
        .readiness-next-step__title{
          margin:0;
          font-size:21px;
          line-height:1.35;
        }
        .readiness-next-step__text{
          margin:0;
          color:#374151;
          line-height:1.65;
        }
        .readiness-next-step__actions{
          display:flex;
          align-items:center;
          justify-content:flex-end;
          gap:10px;
          flex-wrap:wrap;
        }
        .readiness-secondary-link{
          display:inline-flex;
          min-height:44px;
          align-items:center;
          padding:0 14px;
          border:1px solid #d1d5db;
          border-radius:999px;
          background:#fff;
          color:#111827;
          font-weight:800;
          text-decoration:none;
          white-space:nowrap;
        }
        .readiness-grid{
          display:grid;
          grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));
          gap:14px;
        }
        .readiness-metric{
          border:1px solid #e5e7eb;
          border-radius:12px;
          padding:16px;
          display:grid;
          gap:6px;
          min-width:0;
        }
        .readiness-metric__label{
          margin:0;
          color:#6b7280;
          font-size:13px;
          font-weight:700;
        }
        .readiness-metric__value{
          margin:0;
          font-size:22px;
          line-height:1.2;
          font-weight:900;
          overflow-wrap:anywhere;
        }
        .readiness-metric__value--compact{
          font-size:20px;
        }
        .readiness-section-title{
          margin:0 0 14px;
          font-size:20px;
        }
        .readiness-table{
          width:100%;
          border-collapse:collapse;
        }
        .readiness-table th,
        .readiness-table td{
          padding:14px 12px;
          border-bottom:1px solid #eef2f7;
          text-align:left;
          vertical-align:top;
        }
        .readiness-table th{
          color:#6b7280;
          font-size:13px;
          white-space:nowrap;
        }
        #checkout-validation-replay-evidence{
          scroll-margin-top:24px;
        }
        .readiness-status{
          display:inline-flex;
          align-items:center;
          min-height:28px;
          padding:0 10px;
          border-radius:999px;
          font-weight:800;
          font-size:12px;
          border:1px solid;
          white-space:nowrap;
        }
        .readiness-status--pass{
          color:#047857;
          background:#ecfdf5;
          border-color:#a7f3d0;
        }
        .readiness-status--fail{
          color:#b91c1c;
          background:#fef2f2;
          border-color:#fecaca;
        }
        .readiness-status--warning{
          color:#92400e;
          background:#fffbeb;
          border-color:#fde68a;
        }
        .readiness-status--manual{
          color:#374151;
          background:#f9fafb;
          border-color:#d1d5db;
        }
        .readiness-status--optional{
          color:#1f2937;
          background:#f3f4f6;
          border-color:#d1d5db;
        }
        .readiness-actions{
          margin:0;
          padding-left:18px;
          color:#374151;
          line-height:1.7;
        }
        .readiness-action-stack{
          display:grid;
          gap:8px;
          align-items:start;
        }
        .readiness-action-link{
          display:inline-flex;
          width:max-content;
          min-height:32px;
          align-items:center;
          border:1px solid #d1d5db;
          border-radius:999px;
          padding:0 12px;
          color:#111827;
          background:#fff;
          font-weight:900;
          text-decoration:none;
        }
        .readiness-link{
          color:#111827;
          font-weight:800;
        }
        .readiness-tool{
          display:flex;
          justify-content:space-between;
          gap:16px;
          align-items:center;
          flex-wrap:wrap;
        }
        .readiness-tool__body{
          display:grid;
          gap:6px;
          min-width:260px;
        }
        .readiness-tool__title{
          margin:0;
          font-size:18px;
          font-weight:900;
        }
        .readiness-tool__text{
          margin:0;
          color:#4b5563;
          line-height:1.7;
        }
        .readiness-button{
          border:0;
          border-radius:999px;
          min-height:44px;
          padding:0 18px;
          background:#111827;
          color:#fff;
          font-weight:900;
          cursor:pointer;
          white-space:nowrap;
        }
        .readiness-button:disabled{
          cursor:wait;
          opacity:.65;
        }
        .readiness-button--danger{
          background:#b91c1c;
        }
        .readiness-inline-form{
          display:flex;
          gap:8px;
          align-items:center;
          flex-wrap:wrap;
        }
        .readiness-inline-form input{
          min-height:42px;
          min-width:180px;
          border:1px solid #cbd5e1;
          border-radius:8px;
          padding:8px 10px;
          font:inherit;
        }
        .readiness-release-manifest{
          flex:1 0 100%;
          display:grid;
          grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
          gap:10px;
          border:1px solid #cbd5e1;
          border-radius:8px;
          padding:12px;
        }
        .readiness-release-manifest legend{
          padding:0 6px;
          font-weight:800;
        }
        .readiness-release-manifest label{
          display:flex;
          gap:8px;
          align-items:center;
        }
        .readiness-release-manifest label:has(input:not([type="checkbox"])){
          align-items:stretch;
          flex-direction:column;
        }
        .readiness-release-manifest input{
          width:100%;
          min-width:0;
        }
        .readiness-release-manifest input[type="checkbox"]{
          width:18px;
          min-width:18px;
          min-height:18px;
        }
        .readiness-result{
          margin:14px 0 0;
          border:1px solid #d1fae5;
          background:#ecfdf5;
          color:#065f46;
          border-radius:12px;
          padding:12px 14px;
          line-height:1.7;
        }
        .readiness-result--error{
          border-color:#fecaca;
          background:#fef2f2;
          color:#991b1b;
        }
        @media (max-width: 720px){
          .readiness-page{
            padding:16px;
          }
          .readiness-next-step{
            align-items:stretch;
            flex-direction:column;
          }
          .readiness-next-step__actions{
            justify-content:flex-start;
          }
          .readiness-table{
            min-width:760px;
          }
          .readiness-table-wrap{
            overflow-x:auto;
          }
        }
`;

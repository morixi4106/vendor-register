export const withdrawalDetailStyles = `
  .withdrawal-detail{
    display:grid;
    gap:20px;
    padding:24px;
    min-height:100%;
    background:#f3f4f6;
    color:#111827;
  }
  .withdrawal-detail__card{
    background:#fff;
    border:1px solid #e5e7eb;
    border-radius:16px;
    padding:22px;
  }
  .withdrawal-detail__header{
    display:flex;
    justify-content:space-between;
    gap:18px;
    align-items:flex-start;
    flex-wrap:wrap;
  }
  .withdrawal-detail__back{
    color:#4b5563;
    display:inline-block;
    font-weight:800;
    margin-bottom:12px;
    text-decoration:none;
  }
  .withdrawal-detail h1,
  .withdrawal-detail h2{
    margin:0 0 12px;
  }
  .withdrawal-detail p{
    color:#4b5563;
    line-height:1.8;
    margin:0 0 12px;
  }
  .withdrawal-detail__badges,
  .withdrawal-detail__button-row{
    display:flex;
    flex-wrap:wrap;
    gap:10px;
  }
  .withdrawal-detail__guard{
    display:grid;
    gap:6px;
    min-width:160px;
    border:1px solid #e5e7eb;
    border-radius:12px;
    padding:12px;
    background:#f9fafb;
  }
  .withdrawal-detail__guard span{
    color:#4b5563;
  }
  .withdrawal-detail__badge{
    border-radius:999px;
    border:1px solid #d1d5db;
    display:inline-flex;
    font-size:13px;
    font-weight:800;
    padding:6px 12px;
    white-space:nowrap;
  }
  .withdrawal-detail__badge--success{background:#ecfdf5;border-color:#a7f3d0;color:#047857;}
  .withdrawal-detail__badge--warning{background:#fffbeb;border-color:#fde68a;color:#92400e;}
  .withdrawal-detail__badge--danger{background:#fef2f2;border-color:#fecaca;color:#b91c1c;}
  .withdrawal-detail__badge--info,
  .withdrawal-detail__badge--neutral{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8;}
  .withdrawal-detail__notice{
    border-radius:12px;
    font-weight:800;
    padding:14px 18px;
  }
  .withdrawal-detail__notice--ok{background:#ecfdf5;border:1px solid #a7f3d0;color:#047857;}
  .withdrawal-detail__notice--error{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;}
  .withdrawal-detail__alert{
    background:#fffbeb;
    border-color:#fde68a;
    color:#92400e;
    display:grid;
    gap:10px;
  }
  .withdrawal-detail__alert h2{
    color:#78350f;
  }
  .withdrawal-detail__alert p{
    color:#92400e;
  }
  .withdrawal-detail__alert ul{
    line-height:1.7;
    margin:0;
    padding-left:22px;
  }
  .withdrawal-detail__next strong{
    display:block;
    font-size:20px;
    margin-bottom:8px;
  }
  .withdrawal-detail__next ol{
    margin:12px 0 0;
    padding-left:22px;
    color:#4b5563;
    line-height:1.8;
  }
  .withdrawal-detail__quick-panel{
    display:grid;
    gap:16px;
  }
  .withdrawal-detail__quick-panel p{
    max-width:760px;
  }
  .withdrawal-detail__quick-grid{
    display:grid;
    gap:12px;
    grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));
  }
  .withdrawal-detail__quick-action{
    align-content:start;
    background:#f9fafb;
    border:1px solid #e5e7eb;
    border-radius:14px;
    display:grid;
    gap:10px;
    padding:14px;
  }
  .withdrawal-detail__quick-action strong{
    font-size:16px;
  }
  .withdrawal-detail__quick-action span{
    color:#4b5563;
    font-size:13px;
    line-height:1.6;
  }
  .withdrawal-detail__decision{
    display:grid;
    gap:16px;
  }
  .withdrawal-detail__decision-header{
    align-items:flex-start;
    display:flex;
    gap:16px;
    justify-content:space-between;
  }
  .withdrawal-detail__section-header{
    align-items:flex-start;
    display:flex;
    gap:16px;
    justify-content:space-between;
  }
  .withdrawal-detail__link-button{
    align-items:center;
    background:#111827;
    border-radius:10px;
    color:#fff;
    display:inline-flex;
    flex:0 0 auto;
    font-weight:900;
    justify-content:center;
    min-height:42px;
    padding:0 16px;
    text-decoration:none;
  }
  .withdrawal-detail__decision-list{
    background:#f9fafb;
    border:1px solid #e5e7eb;
    border-radius:12px;
    color:#374151;
    line-height:1.7;
    margin:0;
    padding:14px 18px 14px 34px;
  }
  .withdrawal-detail__grid{
    display:grid;
    gap:20px;
    grid-template-columns:repeat(2, minmax(0, 1fr));
  }
  .withdrawal-detail__wide{
    grid-column:1 / -1;
  }
  .withdrawal-detail__subtext{
    color:#4b5563;
    line-height:1.7;
    margin:0 0 16px;
  }
  .withdrawal-detail__checklist{
    display:grid;
    gap:10px;
    grid-template-columns:repeat(auto-fit, minmax(260px, 1fr));
  }
  .withdrawal-detail__steps{
    display:grid;
    gap:10px;
    grid-template-columns:repeat(auto-fit, minmax(260px, 1fr));
  }
  .withdrawal-detail__check{
    align-items:flex-start;
    border:1px solid #e5e7eb;
    border-radius:12px;
    display:flex;
    gap:12px;
    justify-content:space-between;
    padding:14px;
  }
  .withdrawal-detail__step{
    align-items:flex-start;
    background:#f9fafb;
    border:1px solid #e5e7eb;
    border-radius:12px;
    display:flex;
    gap:12px;
    justify-content:space-between;
    padding:14px;
  }
  .withdrawal-detail__check strong,
  .withdrawal-detail__check span,
  .withdrawal-detail__step strong,
  .withdrawal-detail__step span{
    display:block;
  }
  .withdrawal-detail__check span,
  .withdrawal-detail__step span{
    color:#6b7280;
    font-size:13px;
    line-height:1.6;
    margin-top:4px;
  }
  .withdrawal-detail__dl{
    display:grid;
    margin:0;
  }
  .withdrawal-detail__dl div{
    border-bottom:1px solid #e5e7eb;
    display:grid;
    gap:16px;
    grid-template-columns:180px minmax(0, 1fr);
    padding:12px 0;
  }
  .withdrawal-detail__dl dt{
    color:#4b5563;
    font-weight:800;
  }
  .withdrawal-detail__dl dd{
    margin:0;
    overflow-wrap:anywhere;
  }
  .withdrawal-detail__form{
    display:flex;
    flex-direction:column;
    gap:14px;
  }
  .withdrawal-detail__form--spaced{
    margin-top:20px;
  }
  .withdrawal-detail__form label{
    display:flex;
    flex-direction:column;
    gap:6px;
  }
  .withdrawal-detail__form label span{
    color:#4b5563;
    font-size:13px;
    font-weight:800;
  }
  .withdrawal-detail__form input,
  .withdrawal-detail__form select,
  .withdrawal-detail__form textarea{
    border:1px solid #d1d5db;
    border-radius:10px;
    font:inherit;
    padding:10px 12px;
  }
  .withdrawal-detail__form textarea{
    min-height:84px;
  }
  .withdrawal-detail__checkbox{
    align-items:center;
    flex-direction:row !important;
  }
  .withdrawal-detail__checkbox input{
    width:auto;
  }
  .withdrawal-detail button{
    background:#111827;
    border:0;
    border-radius:10px;
    color:#fff;
    cursor:pointer;
    font:inherit;
    font-weight:800;
    padding:10px 16px;
  }
  .withdrawal-detail button:disabled{
    cursor:wait;
    opacity:.6;
  }
  .withdrawal-detail__button--success{
    background:#047857 !important;
  }
  .withdrawal-detail__button--warning{
    background:#92400e !important;
  }
  .withdrawal-detail__button--danger{
    background:#b91c1c !important;
  }
  .withdrawal-detail__button--neutral{
    background:#111827 !important;
  }
  .withdrawal-detail__amount-grid{
    display:grid;
    gap:12px;
    grid-template-columns:repeat(2, minmax(0, 1fr));
  }
  .withdrawal-detail__hint{
    background:#fffbeb;
    border:1px solid #fde68a;
    border-radius:12px;
    color:#92400e;
    line-height:1.7;
    margin-top:16px;
    padding:12px;
  }
  .withdrawal-detail__warning-list{
    background:#fffbeb;
    border:1px solid #fde68a;
    border-radius:12px;
    color:#92400e;
    line-height:1.7;
    margin-top:16px;
    padding:12px 14px;
  }
  .withdrawal-detail__warning-list ul{
    margin:8px 0 0;
    padding-left:20px;
  }
  .withdrawal-detail__ok-note{
    background:#ecfdf5;
    border:1px solid #a7f3d0;
    border-radius:12px;
    color:#047857;
    font-weight:800;
    margin-top:16px;
    padding:12px 14px;
  }
  .withdrawal-detail__table-wrap{
    margin-top:18px;
    overflow:auto;
  }
  .withdrawal-detail__table{
    border-collapse:collapse;
    min-width:640px;
    width:100%;
  }
  .withdrawal-detail__table th,
  .withdrawal-detail__table td{
    border-bottom:1px solid #e5e7eb;
    padding:12px 10px;
    text-align:left;
    vertical-align:top;
  }
  .withdrawal-detail__table th{
    color:#4b5563;
    font-size:13px;
    white-space:nowrap;
  }
  .withdrawal-detail__quick-actions,
  .withdrawal-detail__inline-form{
    border-top:1px solid #e5e7eb;
    margin-top:20px;
    padding-top:20px;
  }
  .withdrawal-detail__raw{
    margin-top:18px;
  }
  .withdrawal-detail__raw summary{
    color:#4b5563;
    cursor:pointer;
    font-weight:800;
  }
  .withdrawal-detail__pre{
    background:#0f172a;
    border-radius:12px;
    color:#e2e8f0;
    max-height:360px;
    overflow:auto;
    padding:16px;
  }
  .withdrawal-detail__timeline{
    display:flex;
    flex-direction:column;
    gap:12px;
  }
  .withdrawal-detail__timeline > div{
    border:1px solid #e5e7eb;
    border-radius:12px;
    padding:12px;
  }
  .withdrawal-detail__timeline span{
    color:#6b7280;
    display:block;
    font-size:13px;
    margin-top:4px;
  }
  .withdrawal-detail__empty{
    border:1px dashed #cbd5e1;
    border-radius:12px;
    color:#64748b;
    padding:18px;
  }
  .withdrawal-detail__error{
    color:#b91c1c;
  }
  @media (max-width:900px){
    .withdrawal-detail{
      padding:16px;
    }
    .withdrawal-detail__grid,
    .withdrawal-detail__amount-grid{
      grid-template-columns:1fr;
    }
    .withdrawal-detail__section-header{
      flex-direction:column;
    }
    .withdrawal-detail__dl div{
      grid-template-columns:1fr;
      gap:4px;
    }
  }`;

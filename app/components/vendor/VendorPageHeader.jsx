export default function VendorPageHeader({
  title = "店舗管理",
  storeName,
  search = null,
  actions = null,
}) {
  return (
    <header className="vendor-shell__topbar">
      <div className="vendor-shell__topbar-inner">
        <div className="vendor-shell__brand">
          <p className="vendor-shell__brand-sub">{title}</p>
          <h1 className="vendor-shell__brand-title">
            {storeName || "Vendor Seller Center"}
          </h1>
        </div>

        {search ? <div className="vendor-shell__search-slot">{search}</div> : null}
        {actions ? <div className="vendor-shell__action-slot">{actions}</div> : null}
      </div>
    </header>
  );
}

import { NavLink } from "@remix-run/react";

const NAV_ITEMS = [
  { key: "dashboard", label: "ダッシュボード", to: "/vendor/dashboard", end: true },
  { key: "orders", label: "注文管理", to: "/vendor/orders", end: true },
  { key: "products", label: "商品管理", to: "/vendor/products", end: true },
  { key: "inventory", label: "在庫", to: "/vendor/inventory", end: true },
  { key: "settings", label: "設定", to: "/vendor/settings", end: true },
];

export default function VendorSidebar({ activeItem }) {
  return (
    <aside className="vendor-shell__sidebar">
      <nav className="vendor-shell__nav" aria-label="店舗管理ナビゲーション">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.key}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `vendor-shell__nav-link${
                (activeItem ? activeItem === item.key : isActive) ? " is-active" : ""
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}

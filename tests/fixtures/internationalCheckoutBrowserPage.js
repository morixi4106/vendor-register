import { CHECKOUT_REJECTION } from "../../scripts/international-checkout-browser-policy.mjs";

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
export function checkoutBrowserHtml(
  facts,
  {
    rejected = false,
    script = "",
    hidden = false,
    total = facts.total,
    variantId = facts.variantId,
  } = {},
) {
  const money = (value) => `JPY ${Number(value).toLocaleString("en-US")}`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Isolated checkout fixture</title>
<style>body{font:16px sans-serif;margin:24px;color:#171717}main{max-width:720px;margin:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px;border-bottom:1px solid #ddd}select,button{padding:12px;margin:12px 0}button{background:#222;color:white;border:0}label{display:block}</style>
<main><h1>Checkout fixture</h1><select name="countryCode"><option value="${escape(facts.country)}" selected>${escape(facts.country)}</option></select>
<table aria-label="Order items"><tbody><tr data-product-id="${escape(facts.productId)}" data-product-variant-id="${escape(variantId)}"><td>
<div data-product-title ${hidden ? 'style="display:none"' : ""}>${escape(facts.productTitle)}</div><div data-variant-title>${escape(facts.variantTitle)}</div><div data-seller>${escape(facts.seller)}</div><div data-quantity>1</div></td></tr></tbody></table>
<table aria-label="Cost summary"><tbody>${[
    ["Subtotal", facts.subtotal],
    ["Shipping", facts.shipping],
    ["Taxes", facts.tax],
    ["Total", total],
  ]
    .map(
      ([label, value]) => `<tr><th>${label}</th><td>${money(value)}</td></tr>`,
    )
    .join("")}</tbody></table>
<div data-currency-code>JPY</div><input type="radio" name="shippingMethod" id="shipping" checked><label for="shipping">${escape(facts.deliveryLabel)}</label>
${rejected ? `<p role="alert">${CHECKOUT_REJECTION}</p>` : '<button type="submit">Pay now</button>'}</main>
<script>${script}</script></html>`;
}

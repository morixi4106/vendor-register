export const SHIPPING_CARRIERS = [
  {
    id: "japan_post",
    label: "日本郵便",
    shopifyCompany: "Japan Post",
    region: "domestic",
    trackingUrlTemplate:
      "https://trackings.post.japanpost.jp/services/srv/search/direct?locale=ja&reqCodeNo1={trackingNumber}",
  },
  {
    id: "yamato",
    label: "ヤマト運輸",
    shopifyCompany: "Yamato Transport",
    region: "domestic",
    trackingUrlTemplate:
      "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number00=1&number01={trackingNumber}",
  },
  {
    id: "sagawa",
    label: "佐川急便",
    shopifyCompany: "Sagawa Express",
    region: "domestic",
    trackingUrlTemplate:
      "https://k2k.sagawa-exp.co.jp/p/sagawa/web/okurijoinput.jsp?okurijoNo={trackingNumber}",
  },
  {
    id: "ems",
    label: "EMS",
    shopifyCompany: "Japan Post",
    region: "international",
    trackingUrlTemplate:
      "https://trackings.post.japanpost.jp/services/srv/search/direct?locale=ja&reqCodeNo1={trackingNumber}",
  },
  {
    id: "dhl",
    label: "DHL",
    shopifyCompany: "DHL Express",
    region: "international",
    trackingUrlTemplate:
      "https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id={trackingNumber}",
  },
  {
    id: "fedex",
    label: "FedEx",
    shopifyCompany: "FedEx",
    region: "international",
    trackingUrlTemplate:
      "https://www.fedex.com/fedextrack/?trknbr={trackingNumber}",
  },
  {
    id: "ups",
    label: "UPS",
    shopifyCompany: "UPS",
    region: "international",
    trackingUrlTemplate: "https://www.ups.com/track?tracknum={trackingNumber}",
  },
];

const SHIPPING_CARRIER_BY_ID = new Map(
  SHIPPING_CARRIERS.map((carrier) => [carrier.id, carrier]),
);

function normalizeCountryCode(value) {
  return String(value || "").trim().toUpperCase();
}

export function getShippingCarrierById(id) {
  return SHIPPING_CARRIER_BY_ID.get(String(id || "").trim()) || null;
}

export function listShippingCarriersForCountry(countryCode) {
  const normalizedCountryCode = normalizeCountryCode(countryCode);

  if (!normalizedCountryCode) {
    return SHIPPING_CARRIERS;
  }

  const region = normalizedCountryCode === "JP" ? "domestic" : "international";
  return SHIPPING_CARRIERS.filter((carrier) => carrier.region === region);
}

export function buildCarrierTrackingUrl(carrier, trackingNumber) {
  const template = String(carrier?.trackingUrlTemplate || "").trim();
  const normalizedTrackingNumber = String(trackingNumber || "").trim();

  if (!template || !normalizedTrackingNumber) {
    return null;
  }

  return template.replace(
    "{trackingNumber}",
    encodeURIComponent(normalizedTrackingNumber),
  );
}

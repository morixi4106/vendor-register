export const VENDOR_STORE_PUBLICATION_STATES = Object.freeze({
  PLATFORM_COLLECTION: "PLATFORM_COLLECTION",
  DOMESTIC_PILOT: "DOMESTIC_PILOT",
  TEST_DATA: "TEST_DATA",
  MARKETPLACE_DISABLED: "MARKETPLACE_DISABLED",
});

export function getVendorStorePublicationState(
  store,
  {
    draftOrderCheckoutEnabled = false,
    domesticMarketplacePilotEnabled = false,
    activePilotStoreId = null,
  } = {},
) {
  if (store?.isTestStore === true) {
    return {
      code: VENDOR_STORE_PUBLICATION_STATES.TEST_DATA,
      label: "サイト非掲載",
      detail: "テストデータのため公開APIから除外されています。",
      tone: "neutral",
      visible: false,
    };
  }

  if (store?.isPlatformStore === true) {
    return {
      code: VENDOR_STORE_PUBLICATION_STATES.PLATFORM_COLLECTION,
      label: "運営直販として掲載対象",
      detail: "Shopifyコレクションへの掲載対象です。",
      tone: "success",
      visible: true,
    };
  }

  const isActivePilot =
    draftOrderCheckoutEnabled === true &&
    domesticMarketplacePilotEnabled === true &&
    Boolean(activePilotStoreId) &&
    activePilotStoreId === store?.id;

  if (isActivePilot) {
    return {
      code: VENDOR_STORE_PUBLICATION_STATES.DOMESTIC_PILOT,
      label: "国内パイロット掲載中",
      detail: "承認済みの国内販売パイロットとして公開APIに掲載されています。",
      tone: "success",
      visible: true,
    };
  }

  return {
    code: VENDOR_STORE_PUBLICATION_STATES.MARKETPLACE_DISABLED,
    label: "サイト非掲載",
    detail:
      "実運用データですが、第三者店舗の掲載には国内販売パイロットの承認と購入導線の有効化が必要です。",
    tone: "warning",
    visible: false,
  };
}

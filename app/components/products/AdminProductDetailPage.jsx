import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import { CATEGORY_DELIVERY_POLICY_TEMPLATES, DELIVERY_COUNTRY_GROUPS, DELIVERY_COUNTRY_OPTIONS, getRecommendedDeliveryPolicyTemplate, normalizeProductCountryPolicy } from "../../utils/productCountryPolicy";
import { PRODUCT_SHIPPING_METHOD, PRODUCT_SHIPPING_METHOD_OPTIONS, getProductShippingMethodLabel, millimetersToCentimeters } from "../../utils/productShippingProfile";
import { PRODUCT_EU_STATUS_OPTIONS, getPublicShopifyReconnectNotice } from "../../services/adminProductDetail.js";
function getPresetTemplateValue(template) {
  return `preset:${template.key}`;
}
function serializePresetDeliveryTemplate(template) {
  const policy = normalizeProductCountryPolicy(template);
  return {
    key: template.key,
    value: getPresetTemplateValue(template),
    source: "preset",
    label: template.label || template.name,
    name: template.name || template.label,
    categoryName: template.name || template.label,
    description: template.description || "",
    productEuStatus: template.productEuStatus || "DISABLED",
    allowedCountries: policy.allowedCountries,
    blockedCountries: policy.blockedCountries,
    requiresWarningCountries: policy.requiresWarningCountries
  };
}
function getProductEuStatusLabel(status) {
  return PRODUCT_EU_STATUS_OPTIONS.find(option => option.value === status)?.label || status || "-";
}
function CountryCheckboxSelector({
  name,
  title,
  description,
  selectedCountries = [],
  defaultOpen = false,
  tone = "neutral"
}) {
  const selectedCountrySet = new Set(selectedCountries);
  const toneColor = tone === "danger" ? "#b91c1c" : tone === "success" ? "#047857" : "#92400e";
  return <details open={defaultOpen} style={{
    border: "1px solid #e5e7eb",
    borderRadius: "8px",
    background: "#fff",
    padding: "10px 12px"
  }}>
      <summary style={{
      cursor: "pointer",
      fontWeight: 800,
      color: toneColor
    }}>
        {title}
      </summary>
      <p style={{
      margin: "8px 0 12px",
      color: "#6b7280",
      fontSize: "13px"
    }}>
        {description}
      </p>
      <div style={{
      display: "grid",
      gap: "12px"
    }}>
        {DELIVERY_COUNTRY_GROUPS.map(group => <div key={`${name}-${group.key}`}>
            <div style={{
          fontWeight: 800,
          fontSize: "13px",
          marginBottom: "8px"
        }}>
              {group.label}
            </div>
            <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: "8px"
        }}>
              {group.options.map(country => <label key={`${name}-${country.code}`} style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            gap: "8px",
            alignItems: "center",
            minHeight: "34px",
            padding: "7px 9px",
            border: "1px solid #e5e7eb",
            borderRadius: "8px",
            background: "#f9fafb",
            fontSize: "13px",
            fontWeight: 700
          }}>
                  <input defaultChecked={selectedCountrySet.has(country.code)} name={name} type="checkbox" value={country.code} />
                  <span>{country.label}</span>
                  <small style={{
              color: "#6b7280",
              fontWeight: 800
            }}>
                    {country.code}
                  </small>
                </label>)}
            </div>
          </div>)}
      </div>
    </details>;
}
function getAdminCountryLabel(code) {
  return DELIVERY_COUNTRY_OPTIONS.find(country => country.code === code)?.label || code;
}
function CountryChipList({
  countries = [],
  emptyLabel = "なし",
  limit = 24,
  tone = "neutral"
}) {
  const normalizedCountries = normalizeProductCountryPolicy({
    allowedCountries: countries
  }).allowedCountries;
  const visibleCountries = normalizedCountries.slice(0, limit);
  const remainingCount = normalizedCountries.length - visibleCountries.length;
  const colors = tone === "danger" ? {
    border: "#fecaca",
    background: "#fff1f2",
    color: "#991b1b"
  } : tone === "warning" ? {
    border: "#fed7aa",
    background: "#fff7ed",
    color: "#9a3412"
  } : tone === "success" ? {
    border: "#bbf7d0",
    background: "#f0fdf4",
    color: "#166534"
  } : {
    border: "#d1d5db",
    background: "#f9fafb",
    color: "#374151"
  };
  if (normalizedCountries.length === 0) {
    return <p style={{
      margin: 0,
      color: "#6b7280"
    }}>{emptyLabel}</p>;
  }
  return <div style={{
    display: "flex",
    flexWrap: "wrap",
    gap: "8px"
  }}>
      {visibleCountries.map(countryCode => <span key={countryCode} style={{
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      minHeight: "30px",
      padding: "4px 9px",
      borderRadius: "999px",
      border: `1px solid ${colors.border}`,
      background: colors.background,
      color: colors.color,
      fontSize: "13px",
      fontWeight: 800
    }}>
          {getAdminCountryLabel(countryCode)}
          <small style={{
        color: "#6b7280",
        fontWeight: 800
      }}>
            {countryCode}
          </small>
        </span>)}
      {remainingCount > 0 ? <span style={{
      display: "inline-flex",
      alignItems: "center",
      minHeight: "30px",
      padding: "4px 9px",
      borderRadius: "999px",
      border: "1px solid #d1d5db",
      background: "#ffffff",
      color: "#374151",
      fontSize: "13px",
      fontWeight: 800
    }}>
          ほか{remainingCount}件
        </span> : null}
    </div>;
}
function DeliveryTemplateSummary({
  template,
  title = "選択中テンプレート"
}) {
  if (!template) {
    return null;
  }
  const policy = normalizeProductCountryPolicy(template);
  return <div style={{
    display: "grid",
    gap: "12px",
    padding: "12px",
    borderRadius: "8px",
    border: "1px solid #d1d5db",
    background: "#f8fafc"
  }}>
      <div>
        <div style={{
        fontSize: "13px",
        color: "#64748b",
        fontWeight: 800
      }}>
          {title}
        </div>
        <div style={{
        marginTop: "3px",
        fontSize: "16px",
        fontWeight: 900
      }}>
          {template.label || template.name}
        </div>
        {template.description ? <p style={{
        margin: "6px 0 0",
        color: "#64748b",
        lineHeight: 1.6
      }}>
            {template.description}
          </p> : null}
      </div>

      <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
      gap: "12px"
    }}>
        <div>
          <div style={{
          marginBottom: "7px",
          fontWeight: 900
        }}>
            販売できる国
          </div>
          <CountryChipList countries={policy.allowedCountries} emptyLabel="国を限定しない設定です" tone="success" />
        </div>

        <div>
          <div style={{
          marginBottom: "7px",
          fontWeight: 900
        }}>
            購入できない国
          </div>
          <CountryChipList countries={policy.blockedCountries} tone="danger" />
        </div>

        <div>
          <div style={{
          marginBottom: "7px",
          fontWeight: 900
        }}>
            注意確認が必要な国
          </div>
          <CountryChipList countries={policy.requiresWarningCountries} tone="warning" />
        </div>
      </div>

      <div style={{
      color: "#475569",
      fontSize: "13px",
      fontWeight: 800
    }}>
        EU販売ステータス: {getProductEuStatusLabel(template.productEuStatus)}
      </div>
    </div>;
}
function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("ja-JP");
}
function getApplyLogStatusLabel(status = "") {
  switch (status) {
    case "success":
      return "Success";
    case "invalid":
      return "Invalid";
    case "apply_failed":
      return "Apply failed";
    default:
      return status || "-";
  }
}
function getApplyLogStatusColor(status = "") {
  switch (status) {
    case "success":
      return "#065f46";
    case "invalid":
      return "#b45309";
    case "apply_failed":
      return "#b91c1c";
    default:
      return "#374151";
  }
}
export default function AdminProductDetail() {
  const {
    product,
    shopifyPrice,
    needsReconnect,
    shopifyNotice,
    priceBreakdown,
    customDeliveryTemplates = [],
    reconnectShopDomain,
    showInternalPriceDebug,
    priceDebug
  } = useLoaderData();
  const actionData = useActionData();
  const [shippingMethod, setShippingMethod] = useState(product.internationalShippingMethod || PRODUCT_SHIPPING_METHOD.UNCONFIGURED);
  useEffect(() => {
    setShippingMethod(product.internationalShippingMethod || PRODUCT_SHIPPING_METHOD.UNCONFIGURED);
  }, [product.id, product.internationalShippingMethod]);
  const priceState = priceDebug?.priceState || null;
  const priceApplyLogs = priceDebug?.priceApplyLogs || [];
  const publicReconnectMessage = shopifyNotice || getPublicShopifyReconnectNotice();
  const reconnectMessage = showInternalPriceDebug ? priceDebug?.shopifyError || publicReconnectMessage : publicReconnectMessage;
  const actionErrorMessage = actionData?.error;
  const recommendedDeliveryTemplate = getRecommendedDeliveryPolicyTemplate(product);
  const presetDeliveryTemplates = useMemo(() => CATEGORY_DELIVERY_POLICY_TEMPLATES.map(serializePresetDeliveryTemplate), []);
  const deliveryTemplateOptions = useMemo(() => [...presetDeliveryTemplates, ...customDeliveryTemplates], [presetDeliveryTemplates, customDeliveryTemplates]);
  const recommendedDeliveryTemplateValue = getPresetTemplateValue(recommendedDeliveryTemplate);
  const [selectedDeliveryTemplateValue, setSelectedDeliveryTemplateValue] = useState(recommendedDeliveryTemplateValue);
  const selectedDeliveryTemplate = useMemo(() => deliveryTemplateOptions.find(template => template.value === selectedDeliveryTemplateValue) || deliveryTemplateOptions.find(template => template.value === recommendedDeliveryTemplateValue) || deliveryTemplateOptions[0], [deliveryTemplateOptions, recommendedDeliveryTemplateValue, selectedDeliveryTemplateValue]);
  const currentCountryPolicy = normalizeProductCountryPolicy(product.countryPolicy);
  const currentDeliveryPolicySummary = {
    label: "現在の商品設定",
    description: "保存済みの商品別配送設定です。",
    productEuStatus: product.productEuStatus || "DISABLED",
    ...currentCountryPolicy
  };
  return <div style={{
    padding: "40px",
    maxWidth: "1000px",
    margin: "0 auto"
  }}>
      <h1>{product.name}</h1>

      <p style={{
      color: "#666"
    }}>
        店舗: {product.vendorStore?.storeName || "-"}
      </p>

      {actionErrorMessage ? <div style={{
      marginTop: "20px",
      marginBottom: "20px",
      padding: "14px",
      borderRadius: "8px",
      background: "#fff1f2",
      border: "1px solid #fecdd3",
      color: "#9f1239",
      whiteSpace: "pre-wrap"
    }}>
          <strong>エラー:</strong>
          <div style={{
        marginTop: "8px"
      }}>{actionErrorMessage}</div>

          {actionData?.needsReconnect ? <div style={{
        marginTop: "14px"
      }}>
              <div style={{
          marginBottom: "10px"
        }}>
                Shopifyとの接続を確認してください。
              </div>

              <Form method="post" action="/admin/shopify-reconnect">
                <input type="hidden" name="returnTo" value={`/admin/products/${product.id}`} />
                <input type="hidden" name="shopDomain" value={reconnectShopDomain || ""} />
                <button type="submit" style={{
            height: "40px",
            padding: "0 14px",
            borderRadius: "8px",
            border: "1px solid #111827",
            background: "#111827",
            color: "#fff",
            cursor: "pointer",
            fontWeight: 700
          }}>
                  Shopify再接続
                </button>
              </Form>
            </div> : null}
        </div> : null}

      {needsReconnect ? <div style={{
      marginTop: "20px",
      marginBottom: "20px",
      padding: "14px",
      borderRadius: "8px",
      background: "#fff7ed",
      border: "1px solid #fdba74",
      color: "#9a3412",
      whiteSpace: "pre-wrap"
    }}>
          <strong>Shopify接続エラー:</strong>
          <div style={{
        marginTop: "8px"
      }}>{reconnectMessage}</div>

          <div style={{
        marginTop: "14px"
      }}>
            <Form method="post" action="/admin/shopify-reconnect">
              <input type="hidden" name="returnTo" value={`/admin/products/${product.id}`} />
              <input type="hidden" name="shopDomain" value={reconnectShopDomain || ""} />
              <button type="submit" style={{
            height: "40px",
            padding: "0 14px",
            borderRadius: "8px",
            border: "1px solid #111827",
            background: "#111827",
            color: "#fff",
            cursor: "pointer",
            fontWeight: 700
          }}>
                Shopify再接続
              </button>
            </Form>
          </div>
        </div> : null}

      {actionData?.ok && actionData?.message ? <div style={{
      marginTop: "20px",
      marginBottom: "20px",
      padding: "14px",
      borderRadius: "8px",
      background: "#ecfdf5",
      border: "1px solid #a7f3d0",
      color: "#065f46",
      whiteSpace: "pre-wrap"
    }}>
          <strong>成功:</strong>
          <div style={{
        marginTop: "8px"
      }}>{actionData.message}</div>
        </div> : null}

      {showInternalPriceDebug && priceDebug && priceState ? <>
          <div style={{
        marginTop: "20px",
        padding: "14px",
        borderRadius: "8px",
        background: "#f9fafb",
        border: "1px solid #e5e7eb"
      }}>
            <strong>Price State</strong>
            <div style={{
          marginTop: "8px",
          display: "grid",
          gap: "6px"
        }}>
              <div>Calculation state: {priceState.calculationStatus}</div>
              <div>Price sync status: {priceState.syncLabel}</div>
              <div>Last applied: {formatDateTime(priceState.priceAppliedAt)}</div>
              <div>Last apply attempt: {formatDateTime(priceState.lastPriceApplyAttemptAt)}</div>
              {priceState.calculationReason ? <div style={{
            color: "#b45309"
          }}>
                  Calculation issue: {priceState.calculationReason}
                </div> : null}
              {priceState.syncError ? <div style={{
            color: "#b91c1c"
          }}>
                  Last apply failure: {priceState.syncError}
                </div> : null}
              {priceState.syncStatus === "apply_failed" ? <div style={{
            color: "#1d4ed8"
          }}>
                  Retry from the apply button below after reconnecting Shopify if needed.
                </div> : null}
              {priceState.syncStatus === "invalid" ? <div style={{
            color: "#1d4ed8"
          }}>
                  Fix the pricing inputs, then run apply again from the button below.
                </div> : null}
            </div>
          </div>

          <div style={{
        marginTop: "20px",
        padding: "14px",
        borderRadius: "8px",
        background: "#f9fafb",
        border: "1px solid #e5e7eb"
      }}>
            <strong>Recent Apply Attempts</strong>
            {priceApplyLogs?.length ? <div style={{
          marginTop: "12px",
          display: "grid",
          gap: "10px"
        }}>
                {priceApplyLogs.map(log => {
            const logInput = log?.priceSnapshotJson?.input || null;
            const logSource = log?.priceSnapshotJson?.source || null;
            return <div key={log.id} style={{
              padding: "12px",
              borderRadius: "8px",
              background: "#ffffff",
              border: "1px solid #e5e7eb"
            }}>
                      <div style={{
                display: "flex",
                gap: "10px",
                flexWrap: "wrap",
                alignItems: "center"
              }}>
                        <strong style={{
                  color: getApplyLogStatusColor(log.status)
                }}>
                          {getApplyLogStatusLabel(log.status)}
                        </strong>
                        <span>{formatDateTime(log.attemptedAt)}</span>
                        <span>Shop: {log.shopDomain || "-"}</span>
                        <span>
                          Attempted price:{" "}
                          {typeof log.attemptedPrice === "number" ? `¥${log.attemptedPrice}` : "-"}
                        </span>
                        <span>Formula: {log.priceFormulaVersion || "-"}</span>
                      </div>

                      {logInput ? <div style={{
                marginTop: "8px",
                color: "#4b5563",
                fontSize: "14px"
              }}>
                          Input: {logInput.costAmount ?? "-"} {logInput.costCurrency || "-"} /
                          duty {logInput.dutyCategory || "-"}
                        </div> : null}

                      {logSource ? <div style={{
                marginTop: "4px",
                color: "#6b7280",
                fontSize: "13px"
              }}>
                          Source: {logSource.pricingInput || "-"} /{" "}
                          {logSource.shopSettings || "-"} / {logSource.fxRate || "-"}
                        </div> : null}

                      {log.errorSummary ? <div style={{
                marginTop: "8px",
                color: "#b91c1c"
              }}>
                          Error: {log.errorSummary}
                        </div> : null}
                    </div>;
          })}
              </div> : <div style={{
          marginTop: "12px",
          color: "#6b7280"
        }}>
                No apply attempts yet.
              </div>}
          </div>
        </> : null}

      <div style={{
      display: "grid",
      gap: "20px",
      marginTop: "20px"
    }}>
        <div>
          <h3>配送プロフィール</h3>
          <div style={{
          marginTop: "10px",
          padding: "14px",
          borderRadius: "8px",
          background: "#f9fafb",
          border: "1px solid #e5e7eb"
        }}>
            <p style={{
            marginTop: 0
          }}>
              現在: {getProductShippingMethodLabel(product.internationalShippingMethod)}
            </p>
            <p style={{
            color: "#6b7280",
            fontSize: "14px",
            lineHeight: 1.7
          }}>
              商品1点を発送できる状態に梱包した後の重量・サイズです。Shopifyの商品重量にも同期します。
            </p>

            <Form method="post" style={{
            display: "grid",
            gap: "12px"
          }}>
              <input type="hidden" name="intent" value="save-shipping-profile" />
              <input type="hidden" name="productId" value={product.id} />

              <label style={{
              display: "grid",
              gap: "6px",
              fontWeight: 700
            }}>
                梱包後重量（g）
                <input defaultValue={product.shippingWeightGrams ?? ""} min="1" name="shippingWeightGrams" placeholder="例: 350" required step="1" type="number" style={{
                height: "40px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                padding: "0 10px"
              }} />
                <label style={{
                display: "flex",
                gap: "8px",
                alignItems: "flex-start",
                fontWeight: 600
              }}>
                  <input defaultChecked={Boolean(product.shippingWeightConfirmedAt)} name="shippingWeightConfirmed" required type="checkbox" value="1" />
                  箱・封筒・緩衝材を含む梱包後重量であることを確認しました
                </label>
              </label>

              <label style={{
              display: "grid",
              gap: "6px",
              fontWeight: 700
            }}>
                配送範囲
                <select name="internationalShippingMethod" onChange={event => setShippingMethod(event.currentTarget.value)} required value={shippingMethod} style={{
                height: "40px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                padding: "0 10px"
              }}>
                  <option value={PRODUCT_SHIPPING_METHOD.UNCONFIGURED} disabled>
                    配送範囲を選択してください
                  </option>
                  {PRODUCT_SHIPPING_METHOD_OPTIONS.map(option => <option key={option.value} value={option.value}>
                      {option.label}
                    </option>)}
                </select>
              </label>

              {shippingMethod === PRODUCT_SHIPPING_METHOD.AIR_PACKET ? <div style={{
              display: "grid",
              gap: "8px"
            }}>
                  <strong>梱包後サイズ（cm）</strong>
                  <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: "10px"
              }}>
                    {[["shippingLengthCm", "長さ", product.shippingLengthMm], ["shippingWidthCm", "幅", product.shippingWidthMm], ["shippingHeightCm", "厚さ", product.shippingHeightMm]].map(([name, label, value]) => <input aria-label={`梱包後の${label}`} defaultValue={millimetersToCentimeters(value)} key={name} min="0.1" name={name} placeholder={label} required step="0.1" type="number" style={{
                  height: "40px",
                  borderRadius: "8px",
                  border: "1px solid #d1d5db",
                  padding: "0 10px"
                }} />)}
                  </div>
                  <span style={{
                color: "#6b7280",
                fontSize: "13px"
              }}>
                    通常形状は14.8cm × 10.5cm以上、2kg以下、最長辺60cm以下、
                    三辺合計90cm以下です。巻物形状と複数バリエーションは現在非対応です。
                    設定変更後、チェックアウトへの反映に最大15分かかる場合があります。
                  </span>
                </div> : null}

              <button type="submit" style={{
              minHeight: "40px",
              padding: "0 14px",
              borderRadius: "8px",
              border: "1px solid #111827",
              background: "#111827",
              color: "#fff",
              cursor: "pointer",
              fontWeight: 700,
              justifySelf: "start"
            }}>
                配送情報を保存
              </button>
            </Form>
          </div>
        </div>

        <div>
          <h3>EU販売審査</h3>
          <div style={{
          marginTop: "10px",
          padding: "14px",
          borderRadius: "8px",
          background: "#f9fafb",
          border: "1px solid #e5e7eb"
        }}>
            <p>現在: {getProductEuStatusLabel(product.productEuStatus)}</p>
            <p>
              出店者希望: {product.euSaleRequested ? "あり" : "なし"}
            </p>
            <p style={{
            color: "#6b7280",
            fontSize: "14px"
          }}>
              高リスク商品は承認せず、低リスク商品だけEU向けcheckoutを許可します。
            </p>

            <Form method="post" style={{
            display: "grid",
            gap: "10px",
            marginTop: "14px",
            padding: "12px",
            borderRadius: "8px",
            background: "#ffffff",
            border: "1px solid #e5e7eb"
          }}>
              <input type="hidden" name="intent" value="apply-country-template" />
              <input type="hidden" name="productId" value={product.id} />

              <label style={{
              display: "grid",
              gap: "6px",
              fontWeight: 700
            }}>
                カテゴリ別配送先テンプレート
                <select name="countryPolicyTemplate" value={selectedDeliveryTemplateValue} onChange={event => setSelectedDeliveryTemplateValue(event.currentTarget.value)} style={{
                height: "40px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                padding: "0 10px"
              }}>
                  {deliveryTemplateOptions.map(template => <option key={template.value} value={template.value}>
                      {template.source === "custom" ? "追加: " : ""}
                      {template.label}
                    </option>)}
                </select>
              </label>

              <DeliveryTemplateSummary template={selectedDeliveryTemplate} />

              <div style={{
              color: "#6b7280",
              fontSize: "13px",
              lineHeight: 1.7
            }}>
                推奨: {recommendedDeliveryTemplate.label}
                <br />
                {recommendedDeliveryTemplate.description}
              </div>

              <button type="submit" style={{
              minHeight: "40px",
              padding: "0 14px",
              borderRadius: "8px",
              border: "1px solid #111827",
              background: "#111827",
              color: "#fff",
              cursor: "pointer",
              fontWeight: 700,
              justifySelf: "start"
            }}>
                テンプレを適用して保存
              </button>
            </Form>

            <Form method="post" style={{
            display: "grid",
            gap: "12px",
            marginTop: "14px"
          }}>
              <input type="hidden" name="productId" value={product.id} />

              <DeliveryTemplateSummary template={currentDeliveryPolicySummary} title="保存済みの商品設定" />

              <label style={{
              display: "grid",
              gap: "6px",
              fontWeight: 700
            }}>
                EU販売ステータス
                <select name="productEuStatus" defaultValue={product.productEuStatus || "DISABLED"} style={{
                height: "40px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                padding: "0 10px"
              }}>
                  {PRODUCT_EU_STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>
                      {option.label}
                    </option>)}
                </select>
              </label>

              <CountryCheckboxSelector defaultOpen={currentCountryPolicy.allowedCountries.length > 0} description="選択した場合、この商品は選択した国だけで購入できます。未選択なら国を限定しません。" name="allowedCountries" selectedCountries={currentCountryPolicy.allowedCountries} title="配送できる国を限定する" tone="success" />

              <CountryCheckboxSelector defaultOpen={currentCountryPolicy.blockedCountries.length > 0} description="選択した国では購入できません。配送できる国と重なった場合は、購入できない国が優先されます。" name="blockedCountries" selectedCountries={currentCountryPolicy.blockedCountries} title="購入できない国" tone="danger" />

              <CountryCheckboxSelector defaultOpen={currentCountryPolicy.requiresWarningCountries.length > 0} description="購入前に関税・輸入VAT・通関手数料などの注意確認を表示したい国です。EU宛は承認後も自動で注意確認が必要になります。" name="requiresWarningCountries" selectedCountries={currentCountryPolicy.requiresWarningCountries} title="注意確認が必要な国" tone="warning" />

              <div style={{
              display: "grid",
              gap: "10px",
              padding: "12px",
              borderRadius: "8px",
              border: "1px solid #e5e7eb",
              background: "#ffffff"
            }}>
                <label style={{
                display: "grid",
                gap: "6px",
                fontWeight: 700
              }}>
                  新しいテンプレート名
                  <input name="templateName" placeholder="例: 化粧品 EU書類確認済み" style={{
                  height: "40px",
                  borderRadius: "8px",
                  border: "1px solid #d1d5db",
                  padding: "0 10px"
                }} />
                </label>
                <label style={{
                display: "grid",
                gap: "6px",
                fontWeight: 700
              }}>
                  テンプレート説明
                  <input name="templateDescription" placeholder="任意。あとで選ぶ管理者向けのメモです。" style={{
                  height: "40px",
                  borderRadius: "8px",
                  border: "1px solid #d1d5db",
                  padding: "0 10px"
                }} />
                </label>
              </div>

              <div style={{
              display: "flex",
              gap: "10px",
              flexWrap: "wrap"
            }}>
                <button name="intent" type="submit" value="update-eu-policy" style={{
                minHeight: "40px",
                padding: "0 14px",
                borderRadius: "8px",
                border: "1px solid #111827",
                background: "#111827",
                color: "#fff",
                cursor: "pointer",
                fontWeight: 700
              }}>
                  商品の配送設定を保存
                </button>
                <button name="intent" type="submit" value="save-country-template" style={{
                minHeight: "40px",
                padding: "0 14px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                background: "#ffffff",
                color: "#111827",
                cursor: "pointer",
                fontWeight: 700
              }}>
                  この設定をテンプレートとして保存
                </button>
              </div>
            </Form>
          </div>
        </div>

        <div>
          <h3>基本情報</h3>
          {priceBreakdown ? <div style={{
          marginTop: "10px",
          padding: "10px",
          background: "#f9fafb",
          borderRadius: "8px"
        }}>
              <p>原価(JPY換算): ¥{Math.round(priceBreakdown.costFx)}</p>
              <p>関税: ¥{Math.round(priceBreakdown.duty)}</p>
              <p>関税込原価: ¥{Math.round(priceBreakdown.landed)}</p>
              <p>安全原価: ¥{Math.round(priceBreakdown.safeCost)}</p>
              <p>目標価格: ¥{Math.round(priceBreakdown.target)}</p>
              <p>計算前価格: ¥{Math.round(priceBreakdown.rawPrice)}</p>
              <p><strong>最終価格: ¥{priceBreakdown.finalPrice}</strong></p>
            </div> : null}
          <p>
            原価: {product.costCurrency || "JPY"} {product.costAmount ?? product.price}
          </p>
          <p>
            基準販売価格（JPY）: {priceBreakdown?.finalPrice != null ? `¥${priceBreakdown.finalPrice}` : typeof product.calculatedPrice === "number" ? `¥${product.calculatedPrice}` : "-"}
          </p>
          <p>
            Shopify基準価格: {shopifyPrice ? `¥${shopifyPrice}` : "-"}
          </p>
          <p>状態: {product.approvalStatus}</p>
          <p>Shopify商品ID: {product.shopifyProductId || "-"}</p>
          <p style={{
          color: "#6b7280",
          fontSize: "14px",
          marginTop: "8px"
        }}>
            ※ 原価・通貨・関税設定をもとに基準販売価格（JPY）が計算されます。
          </p>
        </div>

        <div>
          <h3>商品説明</h3>
          <div style={{
          whiteSpace: "pre-wrap"
        }}>
            {product.description || "説明なし"}
          </div>
        </div>

        <div>
          <h3>追加情報</h3>
          <p>カテゴリ: {product.category || "未設定"}</p>
          <p>画像URL: {product.imageUrl || "なし"}</p>
        </div>

        {product.imageUrl ? <div>
            <h3>商品画像</h3>
            <img src={product.imageUrl} alt={product.name} style={{
          width: "320px",
          maxWidth: "100%",
          border: "1px solid #e5e7eb",
          borderRadius: "12px",
          display: "block"
        }} />
          </div> : null}

        <div style={{
        display: "flex",
        gap: "10px",
        marginTop: "20px",
        flexWrap: "wrap"
      }}>
          <Form method="post">
            <input type="hidden" name="intent" value="approve" />
            <input type="hidden" name="productId" value={product.id} />
            <button type="submit">承認する</button>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="reject" />
            <input type="hidden" name="productId" value={product.id} />
            <button type="submit">却下する</button>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="apply-price" />
            <input type="hidden" name="productId" value={product.id} />
            <button type="submit" style={{
            height: "40px",
            padding: "0 14px",
            borderRadius: "8px",
            border: "1px solid #2563eb",
            background: "#2563eb",
            color: "#fff",
            cursor: "pointer",
            fontWeight: 700
          }}>
              価格更新
            </button>
          </Form>

          <a href="/admin/products">← 戻る</a>
        </div>
      </div>
    </div>;
}

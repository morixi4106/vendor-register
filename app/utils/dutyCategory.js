export const DUTY_CATEGORY_MAP = {
  スキンケア: "cosmetics",
  化粧品: "cosmetics",
  コスメ: "cosmetics",
  コスメ・美容: "cosmetics",
  美容・健康: "cosmetics",
};

export function resolveDutyCategory(category) {
  if (!category) return null;
  return DUTY_CATEGORY_MAP[category] || null;
}

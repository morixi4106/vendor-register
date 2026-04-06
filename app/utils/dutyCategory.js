export const DUTY_CATEGORY_MAP = {
  スキンケア: "cosmetics",
  化粧品: "cosmetics",
};

export function resolveDutyCategory(category) {
  if (!category) return null;
  return DUTY_CATEGORY_MAP[category] || null;
}
import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCT_CATEGORY_OPTIONS,
  normalizeProductCategory,
} from "../../app/utils/productCategories.js";

test("product category options match the storefront category list", () => {
  assert.deepEqual(PRODUCT_CATEGORY_OPTIONS, [
    "生活",
    "美容・健康",
    "ファッション",
    "コスメ・美容",
    "レディース服",
    "メンズ服",
    "着物・浴衣",
    "靴・鞄",
    "雑貨・小物",
    "アクセサリー",
    "ハンドメイド",
    "サブカルチャー(アニメ・マンガ・コスプレ類)",
    "食料品・飲料品",
    "電子機器・オフィス用品",
    "住まい・DIY",
    "スポーツ・旅行・アウトドア",
    "ダイエット・サプリ",
    "玩具・キッズ・ベビー",
    "車・バイク用品",
    "カード・フィギュア",
    "日用品",
  ]);
});

test("normalizeProductCategory keeps current categories and maps legacy aliases", () => {
  assert.equal(normalizeProductCategory("コスメ・美容"), "コスメ・美容");
  assert.equal(normalizeProductCategory("化粧品"), "コスメ・美容");
  assert.equal(normalizeProductCategory("Cosmetics"), "コスメ・美容");
  assert.equal(normalizeProductCategory("食品"), "食料品・飲料品");
  assert.equal(normalizeProductCategory("Wine"), "食料品・飲料品");
  assert.equal(normalizeProductCategory("サプリ"), "ダイエット・サプリ");
  assert.equal(normalizeProductCategory("電子機器"), "電子機器・オフィス用品");
  assert.equal(normalizeProductCategory(""), "");
  assert.equal(normalizeProductCategory("未定義カテゴリ"), "");
});

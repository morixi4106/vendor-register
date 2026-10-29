import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const merge = require("../../vendor/deepmerge/index.cjs");

function safe(result) {
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(result.isAdmin, undefined);
  assert.equal(Object.hasOwn(result, "__proto__"), false);
  assert.equal({}.isAdmin, undefined);
}

test("merge rejects prototype keys for null prototypes, placeholders and own keys", () => {
  const poisoned = JSON.parse('{"__proto__":{"isAdmin":true}}');
  for (const target of [
    {},
    Object.create(null),
    JSON.parse('{"__proto__":null}'),
    poisoned,
  ]) {
    safe(merge(target, poisoned));
    safe(merge(target, {}));
  }
  for (const session of [null, undefined, 0, "", false])
    safe(merge({ session }, { session: poisoned }).session);
  safe(merge({}, { session: poisoned }).session);
  safe(merge({}, { items: [poisoned] }).items[0]);
});

test("constructor/prototype keys never invoke custom merge or forbidden getters", () => {
  const source = {};
  for (const key of ["__proto__", "constructor", "prototype"])
    Object.defineProperty(source, key, {
      enumerable: true,
      get() {
        throw new Error("forbidden getter");
      },
    });
  const result = merge(source, source, {
    customMerge() {
      throw new Error("custom merge");
    },
  });
  assert.deepEqual(result, {});
});

test("throwing inherited-property lookup fails closed", () => {
  const target = new Proxy(
    {},
    {
      has() {
        throw new Error("lookup denied");
      },
    },
  );
  assert.deepEqual(merge(target, { safe: { x: 1 } }), {});
});

test("ordinary deep merge, arrays, symbols, special objects and options remain compatible", () => {
  const symbol = Symbol("color");
  const a = { x: { a: 1 }, items: [{ a: 1 }], [symbol]: "red" };
  const b = { x: { b: 2 }, items: [{ b: 2 }] };
  const result = merge(a, b);
  assert.deepEqual(result, {
    x: { a: 1, b: 2 },
    items: [{ a: 1 }, { b: 2 }],
    [symbol]: "red",
  });
  assert.notEqual(result.x, a.x);
  assert.deepEqual(merge([1], [2]), [1, 2]);
  assert.deepEqual(merge({ a: 1 }, [2]), [2]);
  assert.deepEqual(merge([1], { a: 2 }), { a: 2 });
  for (const target of [null, undefined, 0, "", false])
    assert.deepEqual(merge({ session: target }, { session: { safe: 1 } }), {
      session: { safe: 1 },
    });
  const special = { date: new Date(), regex: /a/ };
  const cloned = merge({}, special);
  assert.equal(cloned.date, special.date);
  assert.equal(cloned.regex, special.regex);
  assert.equal(merge({}, { x: a }, { clone: false }).x, a);
  assert.deepEqual(
    merge({ list: [1] }, { list: [2] }, { arrayMerge: (_, source) => source }),
    { list: [2] },
  );
  assert.deepEqual(
    merge(
      { x: 1 },
      { x: { y: 2 } },
      { customMerge: (key) => (key === "x" ? () => "custom" : undefined) },
    ),
    { x: "custom" },
  );
  assert.deepEqual(merge.all([{ a: 1 }, { b: 2 }]), { a: 1, b: 2 });
  assert.throws(() => merge.all({}), /first argument/);
});

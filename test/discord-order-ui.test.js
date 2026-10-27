"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildCustomOrderPayload,
  buildStankOrderPayload
} = require("../discord-order-ui");

const discountedOrder = {
  id: "c067bd27-34b8-4a56-a49e-963f7a4aa70c",
  status: "Neu",
  icName: "Testkunde",
  phone: "555-0100",
  createdAt: "2025-01-01T12:00:00.000Z",
  subtotalPrice: 1000,
  discountAmount: 200,
  couponCode: "OLYMP20",
  couponPercent: 20,
  totalPrice: 800
};

test("shows coupon breakdown in STANK order embeds", () => {
  const payload = buildStankOrderPayload({ ...discountedOrder, type: "stank", quantity: 2 });
  const fields = payload.embeds[0].fields;

  assert.equal(fields.find(field => field.name === "Zwischensumme").value, "1.000 $");
  assert.equal(fields.find(field => field.name === "Coupon").value, "OLYMP20 · 20% Rabatt");
  assert.equal(fields.find(field => field.name === "Rabatt").value, "−200 $");
  assert.equal(fields.find(field => field.name === "Endpreis").value, "800 $");
});

test("shows coupon breakdown in custom order embeds", () => {
  const payload = buildCustomOrderPayload({
    ...discountedOrder,
    type: "custom",
    items: [{ type: "custom", name: "Testartikel", quantity: 1, pricePerItem: 1000, totalPrice: 1000 }]
  });
  const fieldNames = payload.embeds[0].fields.map(field => field.name);

  assert.ok(fieldNames.includes("Zwischensumme"));
  assert.ok(fieldNames.includes("Coupon"));
  assert.ok(fieldNames.includes("Rabatt"));
  assert.ok(fieldNames.includes("Endpreis"));
});

test("keeps the existing total-price field when no coupon was applied", () => {
  const payload = buildCustomOrderPayload({
    ...discountedOrder,
    type: "custom",
    couponCode: "",
    totalPrice: 1000,
    items: [{ type: "custom", name: "Testartikel", quantity: 1, pricePerItem: 1000, totalPrice: 1000 }]
  });
  const fields = payload.embeds[0].fields;

  assert.equal(fields.some(field => field.name === "Coupon"), false);
  assert.equal(fields.find(field => field.name === "Gesamtpreis").value, "1.000 $");
});

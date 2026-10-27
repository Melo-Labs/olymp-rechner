"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  calculateProductionRun,
  terminalProductIds
} = require("../production-utils");

const products = {
  base: {
    name: "Rohprodukt",
    quantityPerCycle: 4,
    cycleHours: 1,
    materials: [{ name: "Grundstoff", quantity: 2, unitCost: 10 }]
  },
  intermediate: {
    name: "Zwischenprodukt",
    quantityPerCycle: 3,
    cycleHours: 0.5,
    materials: [{ name: "Rohprodukt", quantity: 5, productId: "base", unitCost: 0 }]
  },
  final: {
    name: "Endprodukt",
    price: 100,
    quantityPerCycle: 1,
    cycleHours: 0.25,
    materials: [{ name: "Zwischenprodukt", quantity: 2, productId: "intermediate", unitCost: 0 }]
  }
};

test("calculates complete sequential production time and batch costs", () => {
  const result = calculateProductionRun(products, "final");

  assert.deepEqual(result, {
    cost: 40,
    hours: 2.75,
    chain: ["Rohprodukt", "Zwischenprodukt", "Endprodukt"],
    missing: []
  });
});

test("selects only top-level products when a category has production dependencies", () => {
  assert.deepEqual(terminalProductIds(products, ["base", "intermediate", "final"]), ["final"]);
});

test("returns separate products as terminals and flags unpriced raw materials", () => {
  const independent = {
    ...products,
    other: {
      name: "Eigenständiges Produkt",
      quantityPerCycle: 1,
      cycleHours: 0.5,
      price: 40,
      materials: [{ name: "Unbekannter Rohstoff", quantity: 2, unitCost: 0 }]
    }
  };

  assert.deepEqual(terminalProductIds(independent, ["base", "other"]), ["other"]);
  assert.deepEqual(calculateProductionRun(independent, "other").missing, ["Unbekannter Rohstoff"]);
});

test("rejects cyclic or invalid production data", () => {
  const cyclic = {
    first: { name: "Erstes", quantityPerCycle: 1, cycleHours: 1, materials: [{ name: "Zweites", quantity: 1, productId: "second" }] },
    second: { name: "Zweites", quantityPerCycle: 1, cycleHours: 1, materials: [{ name: "Erstes", quantity: 1, productId: "first" }] }
  };

  assert.match(calculateProductionRun(cyclic, "first").error, /Endlosschleife/);
  assert.match(calculateProductionRun(products, "final", 0).error, /gültige Produktionsdaten/);
});

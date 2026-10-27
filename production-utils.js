"use strict";

(function exposeProductionUtils(root) {
  function terminalProductIds(products, categoryIds) {
    const categorySet = new Set(categoryIds);
    const consumed = new Set();
    for (const product of Object.values(products)) {
      for (const material of product.materials) {
        if (categorySet.has(material.productId)) consumed.add(material.productId);
      }
    }
    const terminals = [...categorySet].filter(id => !consumed.has(id));
    return terminals.length ? terminals : [...categorySet];
  }

  function calculateProductionRun(products, id, cycles = 1, ancestors = new Set()) {
    if (ancestors.has(id)) return { error: "Die Produktionsdaten enthalten eine Endlosschleife." };
    const product = products[id];
    if (!product || !Number.isSafeInteger(cycles) || cycles < 1
      || !Number.isFinite(product.cycleHours) || product.cycleHours <= 0
      || !Number.isFinite(product.quantityPerCycle) || product.quantityPerCycle <= 0) {
      return { error: "Für ein Produkt fehlen gültige Produktionsdaten." };
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(id);
    let cost = 0;
    let hours = cycles * product.cycleHours;
    const chain = [];
    const missing = new Set();

    for (const material of product.materials) {
      const quantity = Number(material.quantity) || 0;
      const required = quantity * cycles;
      if (quantity <= 0) continue;
      if (!Number.isFinite(required)) return { error: "Die benötigte Rohstoffmenge ist zu hoch." };

      if (material.productId && products[material.productId]) {
        const dependency = products[material.productId];
        const dependencyCycles = Math.ceil(required / dependency.quantityPerCycle);
        const result = calculateProductionRun(products, material.productId, dependencyCycles, nextAncestors);
        if (result.error) return result;
        cost += result.cost;
        hours += result.hours;
        chain.push(...result.chain);
        result.missing.forEach(name => missing.add(name));
      } else {
        const unitCost = Number(material.unitCost) || 0;
        const materialCost = required * unitCost;
        if (!Number.isFinite(materialCost)) return { error: "Die Rohstoffkosten können nicht berechnet werden." };
        cost += materialCost;
        if (unitCost <= 0) missing.add(material.name);
      }
    }

    if (!Number.isFinite(cost) || !Number.isFinite(hours) || hours <= 0) {
      return { error: "Die Produktionskette kann nicht berechnet werden." };
    }
    chain.push(product.name);
    return { cost, hours, chain: [...new Set(chain)], missing: [...missing] };
  }

  const api = { calculateProductionRun, terminalProductIds };
  root.ProductionUtils = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);

"use strict";

const DISCOUNT_PERCENTAGES = Object.freeze([10, 20, 40]);
const COUPON_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

function normalizeCouponCode(value) {
  if (typeof value !== "string") throw new Error("Bitte einen gültigen Coupon-Code eingeben.");
  const code = value.trim().toUpperCase();
  if (!COUPON_CODE_PATTERN.test(code)) {
    throw new Error("Coupon-Codes müssen 3 bis 32 Zeichen lang sein und dürfen nur Buchstaben, Zahlen und Bindestriche enthalten.");
  }
  return code;
}

function validateCouponDefinition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bitte Coupon-Code und Rabatt auswählen.");
  }
  const normalizedCode = normalizeCouponCode(value.code);
  const discount = Number(value.percent);
  if (!DISCOUNT_PERCENTAGES.includes(discount)) {
    throw new Error("Bitte 10 %, 20 % oder 40 % Rabatt auswählen.");
  }
  const maxUses = value.maxUses ?? null;
  if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1)) {
    throw new Error("Das Einlösungslimit muss eine positive ganze Zahl sein.");
  }
  return { code: normalizedCode, percent: discount, maxUses };
}

function couponUsesRemaining(coupon, usedCount) {
  if (!Number.isSafeInteger(usedCount) || usedCount < 0) {
    throw new Error("Die Anzahl der Coupon-Verwendungen ist ungültig.");
  }
  const maxUses = coupon?.maxUses ?? null;
  if (maxUses === null) return null;
  if (!Number.isSafeInteger(maxUses) || maxUses < 1) {
    throw new Error("Das Einlösungslimit ist ungültig.");
  }
  return Math.max(0, maxUses - usedCount);
}

function findActiveCoupon(coupons, value) {
  if (!Array.isArray(coupons)) throw new Error("Die Coupon-Liste ist ungültig.");
  const code = normalizeCouponCode(value);
  return coupons.find(coupon => coupon && coupon.code === code && coupon.active === true) || null;
}

function calculateCouponPrice(subtotal, percent) {
  if (!Number.isSafeInteger(subtotal) || subtotal < 1) {
    throw new Error("Der Bestellwert muss eine positive ganze Zahl sein.");
  }
  if (!DISCOUNT_PERCENTAGES.includes(percent)) {
    throw new Error("Ungültiger Coupon-Rabatt.");
  }
  const discountAmount = Number((BigInt(subtotal) * BigInt(percent) + 50n) / 100n);
  return {
    subtotal,
    discountAmount,
    total: subtotal - discountAmount
  };
}

module.exports = {
  COUPON_CODE_PATTERN,
  DISCOUNT_PERCENTAGES,
  calculateCouponPrice,
  couponUsesRemaining,
  findActiveCoupon,
  normalizeCouponCode,
  validateCouponDefinition
};

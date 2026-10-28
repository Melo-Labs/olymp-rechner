"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  calculateCouponPrice,
  couponUsesRemaining,
  findActiveCoupon,
  normalizeCouponCode,
  validateCouponDefinition
} = require("../coupon-utils");

test("normalizes coupon codes and restricts supported discounts", () => {
  assert.deepEqual(validateCouponDefinition({ code: "  olymp-10 ", percent: "10" }), {
    code: "OLYMP-10",
    percent: 10,
    maxUses: null,
    minimumOrderValue: null,
    validFrom: null,
    validUntil: null
  });
  assert.deepEqual(validateCouponDefinition({ code: "LIMIT5", percent: 20, maxUses: 5 }), {
    code: "LIMIT5",
    percent: 20,
    maxUses: 5,
    minimumOrderValue: null,
    validFrom: null,
    validUntil: null
  });
  assert.throws(() => validateCouponDefinition(null), /Coupon-Code/);
  assert.throws(() => validateCouponDefinition([]), /Coupon-Code/);
  assert.throws(() => validateCouponDefinition({ code: "LIMIT0", percent: 10, maxUses: 0 }), /positive ganze Zahl/);
  assert.throws(() => validateCouponDefinition({ code: "LIMIT2", percent: 10, maxUses: 1.5 }), /positive ganze Zahl/);
  assert.throws(() => validateCouponDefinition({ code: "LIMIT3", percent: 10, maxUses: "3" }), /positive ganze Zahl/);
  assert.throws(() => normalizeCouponCode("zu kurz"), /Buchstaben/);
  assert.throws(() => validateCouponDefinition({ code: "OLYMP10", percent: 15 }), /10 %/);
});

test("only active matching coupons can be applied", () => {
  const coupons = [
    { code: "OLYMP10", percent: 10, active: false },
    { code: "SOMMER20", percent: 20, active: true }
  ];

  assert.equal(findActiveCoupon(coupons, "olymp10"), null);
  assert.equal(findActiveCoupon(coupons, " sommer20 ").percent, 20);
  assert.equal(findActiveCoupon([null, ...coupons], "SOMMER20").percent, 20);
  assert.throws(() => findActiveCoupon(null, "SOMMER20"), /Coupon-Liste/);
  assert.throws(() => findActiveCoupon(coupons, "bad code"), /Buchstaben/);
});

test("tracks remaining coupon uses and preserves unlimited legacy coupons", () => {
  assert.equal(couponUsesRemaining({ maxUses: null }, 25), null);
  assert.equal(couponUsesRemaining({}, 25), null);
  assert.equal(couponUsesRemaining({ maxUses: 5 }, 2), 3);
  assert.equal(couponUsesRemaining({ maxUses: 5 }, 5), 0);
  assert.equal(couponUsesRemaining({ maxUses: 5 }, 7), 0);
  assert.throws(() => couponUsesRemaining({ maxUses: 5 }, -1), /Verwendungen/);
});

test("calculates integer discounts without exceeding safe integer precision", () => {
  assert.deepEqual(calculateCouponPrice(1000, 40), {
    subtotal: 1000,
    discountAmount: 400,
    total: 600
  });
  assert.deepEqual(calculateCouponPrice(5, 10), {
    subtotal: 5,
    discountAmount: 1,
    total: 4
  });
  assert.equal(calculateCouponPrice(Number.MAX_SAFE_INTEGER, 40).total, 5404319552844595);
  assert.throws(() => calculateCouponPrice(0, 10), /Bestellwert/);
  assert.throws(() => calculateCouponPrice(Number.MAX_SAFE_INTEGER + 1, 10), /Bestellwert/);
  assert.throws(() => calculateCouponPrice(1000, 15), /Rabatt/);
});

const quantityInput = document.getElementById('stank-quantity');
const icNameInput = document.getElementById('stank-ic-name');
const phoneInput = document.getElementById('stank-phone');
const summaryQuantity = document.getElementById('stank-summary-quantity');
const summarySubtotal = document.getElementById('stank-summary-subtotal');
const summaryTotal = document.getElementById('stank-summary-total');
const couponRow = document.getElementById('stank-coupon-row');
const couponDiscount = document.getElementById('stank-coupon-discount');
const couponInput = document.getElementById('stank-coupon-code');
const couponApplyButton = document.getElementById('apply-stank-coupon');
const couponFeedback = document.getElementById('stank-coupon-feedback');
const form = document.getElementById('stank-order-form');
const statusBox = document.getElementById('stank-status');
const numberFormatter = new Intl.NumberFormat('de-DE');
const PRICE_PER_PLANT = 2000;
let activeCoupon = null;
let couponChecking = false;

function formatPrice(value) {
  return `${numberFormatter.format(value)} $`;
}

function updateSummary() {
  const quantity = Math.max(0, Math.floor(Number(quantityInput.value) || 0));
  const subtotal = quantity * PRICE_PER_PLANT;
  const discount = activeCoupon
    ? Number((BigInt(subtotal) * BigInt(activeCoupon.percent) + 50n) / 100n)
    : 0;
  summaryQuantity.textContent = `${numberFormatter.format(quantity)} × ${formatPrice(PRICE_PER_PLANT)}`;
  summarySubtotal.textContent = formatPrice(subtotal);
  couponDiscount.textContent = `−${formatPrice(discount)}`;
  couponRow.hidden = !activeCoupon || discount === 0;
  summaryTotal.textContent = formatPrice(subtotal - discount);
  couponApplyButton.disabled = couponChecking || !couponInput.value.trim() || subtotal < 1;
}

function setCouponFeedback(message, state = '') {
  couponFeedback.textContent = message;
  couponFeedback.className = `status${state ? ` ${state}` : ''}`;
}

async function applyCoupon() {
  const code = couponInput.value.trim();
  const quantity = Number(quantityInput.value);
  const subtotal = quantity * PRICE_PER_PLANT;
  if (!code) {
    activeCoupon = null;
    updateSummary();
    setCouponFeedback('Gib zuerst einen Coupon-Code ein.', 'err');
    return false;
  }
  if (!Number.isSafeInteger(subtotal) || subtotal < 1) {
    setCouponFeedback('Bitte gib zuerst eine gültige Bestellmenge ein.', 'err');
    return false;
  }

  couponChecking = true;
  updateSummary();
  couponApplyButton.textContent = 'Prüfe …';
  try {
    const response = await fetch('/api/coupons/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, subtotal })
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true || !result.coupon) {
      throw new Error(result.message || 'Coupon-Code konnte nicht angewendet werden.');
    }
    activeCoupon = result.coupon;
    couponInput.value = result.coupon.code;
    updateSummary();
    setCouponFeedback(`${result.coupon.percent}% Rabatt angewendet. Du sparst ${formatPrice(result.discountAmount)}.`, 'ok');
    return true;
  } catch (error) {
    activeCoupon = null;
    updateSummary();
    setCouponFeedback(error.message || 'Coupon-Code konnte nicht angewendet werden.', 'err');
    return false;
  } finally {
    couponChecking = false;
    couponApplyButton.textContent = 'Einlösen';
    updateSummary();
  }
}

quantityInput.addEventListener('input', updateSummary);
couponInput.addEventListener('input', () => {
  activeCoupon = null;
  setCouponFeedback('');
  updateSummary();
});
couponApplyButton.addEventListener('click', () => { void applyCoupon(); });
document.querySelectorAll('[data-quantity-step]').forEach((button) => {
  button.addEventListener('click', () => {
    const current = Math.max(1, Math.floor(Number(quantityInput.value) || 1));
    const step = Number(button.dataset.quantityStep);
    quantityInput.value = String(Math.max(1, current + step));
    updateSummary();
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const quantity = Number(quantityInput.value);
  const icName = icNameInput.value.trim();
  const phone = phoneInput.value.trim();

  if (!Number.isInteger(quantity) || quantity < 1) {
    statusBox.textContent = 'Bitte gib mindestens eine STANK-Pflanze ein.';
    statusBox.className = 'status error';
    return;
  }
  if (!icName) {
    statusBox.textContent = 'Bitte gib deinen IC-Namen ein.';
    statusBox.className = 'status error';
    return;
  }
  if (!phone) {
    statusBox.textContent = 'Bitte gib eine Handynummer ein.';
    statusBox.className = 'status error';
    return;
  }

  const requestedCoupon = couponInput.value.trim();
  if (requestedCoupon && requestedCoupon.toUpperCase() !== (activeCoupon?.code || '')) {
    if (!await applyCoupon()) return;
  }

  statusBox.textContent = 'Bestellung wird gesendet...';
  statusBox.className = 'status';
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  couponApplyButton.disabled = true;

  try {
    const response = await fetch('/api/stank-bestellung', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity, icName, phone, couponCode: couponInput.value.trim() })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      throw new Error(result.message || 'Bestellung konnte nicht gesendet werden.');
    }

    statusBox.textContent = result.message || `Bestellung gesendet. Gesamtpreis: ${numberFormatter.format(result.total)} $.`;
    statusBox.className = 'status success';
    activeCoupon = null;
    form.reset();
    quantityInput.value = '1';
    setCouponFeedback('');
    updateSummary();
  } catch (error) {
    statusBox.textContent = error.message || 'Fehler beim Senden der Bestellung.';
    statusBox.className = 'status error';
  } finally {
    submitButton.disabled = false;
    updateSummary();
  }
});

updateSummary();

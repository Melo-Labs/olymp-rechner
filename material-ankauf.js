const technicalInput = document.getElementById('technical');
const medicalInput = document.getElementById('medical');
const totalMaterialsInput = document.getElementById('total-materials');
const summaryTechnical = document.getElementById('summary-technical');
const summaryMedical = document.getElementById('summary-medical');
const summarySubtotal = document.getElementById('summary-subtotal');
const summaryTotal = document.getElementById('summary-total');
const couponInput = document.getElementById('coupon-code');
const couponApplyButton = document.getElementById('apply-coupon');
const couponFeedback = document.getElementById('coupon-feedback');
const couponDiscountRow = document.getElementById('coupon-discount-row');
const couponDiscountOutput = document.getElementById('coupon-discount');
const form = document.getElementById('order-form');
const statusBox = document.getElementById('status');
const submitButton = form.querySelector('[type="submit"]');
const numberFormatter = new Intl.NumberFormat('de-DE');
let activeCoupon = null;
let couponChecking = false;

function formatPrice(value) {
  return `${numberFormatter.format(value)}$`;
}

function normalizeStepValue(value) {
  const raw = String(value).trim();
  if (raw === '') return '';

  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return '0';
  }

  const snapped = Math.round(numeric / 250) * 250;
  return String(snapped);
}

function updateSummary() {
  const technical = Math.max(0, Number(technicalInput.value) || 0);
  const medical = Math.max(0, Number(medicalInput.value) || 0);
  const totalMaterials = technical + medical;
  const technicalPrice = technical * 250;
  const medicalPrice = medical * 150;
  const subtotal = technicalPrice + medicalPrice;
  const discount = activeCoupon && Number.isSafeInteger(subtotal)
    ? Number((BigInt(subtotal) * BigInt(activeCoupon.percent) + 50n) / 100n)
    : 0;

  totalMaterialsInput.value = totalMaterials;
  summaryTechnical.textContent = `${numberFormatter.format(technical)} × 250$ = ${formatPrice(technicalPrice)}`;
  summaryMedical.textContent = `${numberFormatter.format(medical)} × 150$ = ${formatPrice(medicalPrice)}`;
  summarySubtotal.textContent = formatPrice(subtotal);
  couponDiscountOutput.textContent = `−${formatPrice(discount)}`;
  couponDiscountRow.hidden = !activeCoupon;
  summaryTotal.textContent = formatPrice(subtotal - discount);
  couponApplyButton.disabled = couponChecking || !couponInput.value.trim()
    || !Number.isSafeInteger(subtotal) || subtotal < 1;
}

function setCouponFeedback(message, state = '') {
  couponFeedback.textContent = message;
  couponFeedback.className = `coupon-feedback${state ? ` ${state}` : ''}`;
}

async function applyCoupon() {
  const code = couponInput.value.trim();
  const technical = Number(technicalInput.value) || 0;
  const medical = Number(medicalInput.value) || 0;
  const subtotal = technical * 250 + medical * 150;
  if (!code) {
    activeCoupon = null;
    updateSummary();
    setCouponFeedback('Gib zuerst einen Coupon-Code ein.', 'error');
    return false;
  }
  if (!Number.isSafeInteger(subtotal) || subtotal < 1) {
    setCouponFeedback('Bitte gib zuerst eine gültige Materialmenge ein.', 'error');
    return false;
  }

  couponChecking = true;
  couponApplyButton.textContent = 'Prüfe …';
  updateSummary();
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
    setCouponFeedback(`${result.coupon.percent}% Rabatt angewendet. Du sparst ${formatPrice(result.discountAmount)}.`, 'success');
    return true;
  } catch (error) {
    activeCoupon = null;
    updateSummary();
    setCouponFeedback(error.message || 'Coupon-Code konnte nicht angewendet werden.', 'error');
    return false;
  } finally {
    couponChecking = false;
    couponApplyButton.textContent = 'Einlösen';
    updateSummary();
  }
}

[technicalInput, medicalInput].forEach((input) => {
  input.addEventListener('focus', () => {
    if (input.value === '0') input.value = '';
  });

  input.addEventListener('blur', () => {
    if (input.value === '') {
      input.value = '0';
    } else {
      input.value = normalizeStepValue(input.value);
    }
    updateSummary();
  });

  input.addEventListener('input', () => {
    const raw = input.value.trim();
    if (raw === '') {
      updateSummary();
      return;
    }

    const normalized = normalizeStepValue(raw);
    if (normalized !== raw) {
      input.value = normalized;
    }
    updateSummary();
  });
});

document.querySelectorAll('[data-material-step]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.materialStep);
    const current = Math.max(0, Number(input.value) || 0);
    input.value = String(Math.max(0, current + Number(button.dataset.step)));
    updateSummary();
  });
});

couponInput.addEventListener('input', () => {
  activeCoupon = null;
  setCouponFeedback('');
  updateSummary();
});
couponApplyButton.addEventListener('click', () => { void applyCoupon(); });

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const technical = Math.max(0, Number(technicalInput.value) || 0);
  const medical = Math.max(0, Number(medicalInput.value) || 0);
  const icName = document.getElementById('ic-name').value.trim();
  const phone = document.getElementById('phone').value.trim();

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

  if (technical === 0 && medical === 0) {
    statusBox.textContent = 'Bitte gib mindestens eine Materialmenge ein.';
    statusBox.className = 'status error';
    return;
  }

  const requestedCoupon = couponInput.value.trim();
  if (requestedCoupon && requestedCoupon.toUpperCase() !== (activeCoupon?.code || '')) {
    if (!await applyCoupon()) return;
  }

  const payload = {
    technical,
    medical,
    icName,
    phone,
    totalMaterials: technical + medical,
    totalPrice: technical * 250 + medical * 150,
    couponCode: couponInput.value.trim()
  };

  statusBox.textContent = 'Bestellung wird gespeichert...';
  statusBox.className = 'status';
  submitButton.disabled = true;
  couponApplyButton.disabled = true;

  try {
    const response = await fetch('/api/material-bestellung', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || result.ok === false) {
      throw new Error(result.message || 'Bestellung konnte nicht gespeichert werden.');
    }

    statusBox.textContent = result.message || `Bestellung gespeichert. Gesamtpreis: ${result.total} $.`;
    statusBox.className = 'status success';
    form.reset();
    technicalInput.value = '0';
    medicalInput.value = '0';
    activeCoupon = null;
    document.getElementById('ic-name').value = '';
    document.getElementById('phone').value = '';
    setCouponFeedback('');
    updateSummary();
  } catch (error) {
    statusBox.textContent = error.message || 'Bestellung konnte nicht gespeichert werden.';
    statusBox.className = 'status error';
  } finally {
    submitButton.disabled = false;
    updateSummary();
  }
});

updateSummary();

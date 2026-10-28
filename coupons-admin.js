const couponForm = document.getElementById('coupon-form');
const couponCodeInput = document.getElementById('coupon-code');
const couponMaxUsesInput = document.getElementById('coupon-max-uses');
const createButton = document.getElementById('create-coupon');
const couponStatus = document.getElementById('coupon-status');
const couponList = document.getElementById('coupon-list');
let coupons = [];
let loading = false;

function showStatus(message, state = '') {
  couponStatus.textContent = message;
  couponStatus.className = `status ${state}`.trim();
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Zeit unbekannt' : date.toLocaleString('de-DE');
}

function renderCoupons() {
  couponList.replaceChildren();
  if (!coupons.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Noch keine Coupons angelegt. Erstelle oben deinen ersten Rabattcode.';
    couponList.append(empty);
    return;
  }

  for (const coupon of coupons) {
    const card = document.createElement('article');
    card.className = 'coupon-card';
    const info = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'coupon-code';
    title.textContent = coupon.code;
    const discount = document.createElement('span');
    discount.className = 'coupon-badge';
    discount.textContent = `${coupon.percent} %`;
    title.append(discount);
    const state = document.createElement('p');
    state.className = `coupon-state ${coupon.active ? 'active' : 'inactive'}`;
    state.textContent = coupon.active ? 'Aktiv' : 'Deaktiviert';
    const meta = document.createElement('p');
    meta.textContent = `${coupon.uses} Verwendung(en) · erstellt ${dateLabel(coupon.createdAt)} von ${coupon.createdBy}`;
    info.append(title, state, meta);

    const actions = document.createElement('div');
    actions.className = 'coupon-actions';
    const toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.textContent = coupon.active ? 'Deaktivieren' : 'Aktivieren';
    toggleButton.setAttribute('aria-label', `${coupon.active ? 'Deaktivieren' : 'Aktivieren'}: ${coupon.code}`);
    toggleButton.addEventListener('click', () => { void setCouponActive(coupon, toggleButton); });
    const uses = document.createElement('small');
    uses.textContent = coupon.maxUses === null
      ? `${coupon.uses} eingelöst · unbegrenzt`
      : `${coupon.uses}/${coupon.maxUses} eingelöst${coupon.usesRemaining === 0 ? ' · Limit erreicht' : ''}`;
    actions.append(toggleButton, uses);
    card.append(info, actions);
    couponList.append(card);
  }
}

async function loadCoupons() {
  if (loading) return;
  loading = true;
  couponList.textContent = 'Coupons werden geladen …';
  try {
    const response = await fetch('/api/admin/coupons');
    const result = await response.json();
    if (!response.ok || result.ok !== true || !Array.isArray(result.coupons)) {
      throw new Error(result.message || 'Coupons konnten nicht geladen werden.');
    }
    coupons = result.coupons;
    renderCoupons();
  } catch (error) {
    couponList.replaceChildren();
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent = error.message || 'Coupons konnten nicht geladen werden.';
    couponList.append(message);
  } finally {
    loading = false;
  }
}

async function setCouponActive(coupon, button) {
  button.disabled = true;
  try {
    const response = await fetch(`/api/admin/coupons/${encodeURIComponent(coupon.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !coupon.active })
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true || !result.coupon) {
      throw new Error(result.message || 'Coupon-Status konnte nicht geändert werden.');
    }
    coupons = coupons.map(item => item.id === result.coupon.id ? result.coupon : item);
    renderCoupons();
    showStatus(`${result.coupon.code} wurde ${result.coupon.active ? 'aktiviert' : 'deaktiviert'}.`, 'success');
  } catch (error) {
    showStatus(error.message || 'Coupon-Status konnte nicht geändert werden.', 'error');
  } finally {
    button.disabled = false;
  }
}

couponCodeInput.addEventListener('input', () => {
  couponCodeInput.value = couponCodeInput.value.toUpperCase();
});

couponForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!couponForm.reportValidity()) return;
  createButton.disabled = true;
  showStatus('Coupon wird gespeichert …');
  try {
    const response = await fetch('/api/admin/coupons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: couponCodeInput.value.trim(),
        percent: Number(couponForm.elements.percent.value),
        maxUses: couponMaxUsesInput.value.trim() ? Number(couponMaxUsesInput.value) : null
      })
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true || !result.coupon) {
      throw new Error(result.message || 'Coupon konnte nicht erstellt werden.');
    }
    coupons = [result.coupon, ...coupons];
    renderCoupons();
    couponForm.reset();
    const usage = result.coupon.maxUses === null
      ? 'ohne Einlösungslimit'
      : `für ${result.coupon.maxUses} Einlösungen`;
    const notification = result.notificationSent === false
      ? ' Die Discord-Nachricht konnte nicht gesendet werden.'
      : '';
    showStatus(`Coupon ${result.coupon.code} mit ${result.coupon.percent} % Rabatt wurde ${usage} erstellt.${notification}`, result.notificationSent === false ? 'error' : 'success');
  } catch (error) {
    showStatus(error.message || 'Coupon konnte nicht erstellt werden.', 'error');
  } finally {
    createButton.disabled = false;
  }
});

void loadCoupons();

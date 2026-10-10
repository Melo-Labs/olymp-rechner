const quantityInput = document.getElementById('stank-quantity');
const icNameInput = document.getElementById('stank-ic-name');
const phoneInput = document.getElementById('stank-phone');
const summaryQuantity = document.getElementById('stank-summary-quantity');
const summaryTotal = document.getElementById('stank-summary-total');
const form = document.getElementById('stank-order-form');
const statusBox = document.getElementById('stank-status');
const numberFormatter = new Intl.NumberFormat('de-DE');
const PRICE_PER_PLANT = 2000;

function updateSummary() {
  const quantity = Math.max(0, Math.floor(Number(quantityInput.value) || 0));
  summaryQuantity.textContent = `${numberFormatter.format(quantity)} × ${numberFormatter.format(PRICE_PER_PLANT)} $`;
  summaryTotal.textContent = `${numberFormatter.format(quantity * PRICE_PER_PLANT)} $`;
}

quantityInput.addEventListener('input', updateSummary);
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

  statusBox.textContent = 'Bestellung wird gesendet...';
  statusBox.className = 'status';

  try {
    const response = await fetch('/api/stank-bestellung', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity, icName, phone })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      throw new Error(result.message || 'Bestellung konnte nicht gesendet werden.');
    }

    statusBox.textContent = result.message || `Bestellung gesendet. Gesamtpreis: ${numberFormatter.format(result.total)} $.`;
    statusBox.className = 'status success';
    form.reset();
    quantityInput.value = '1';
    updateSummary();
  } catch (error) {
    statusBox.textContent = error.message || 'Fehler beim Senden der Bestellung.';
    statusBox.className = 'status error';
  }
});

updateSummary();

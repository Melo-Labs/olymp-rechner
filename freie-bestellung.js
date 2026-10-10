const form = document.getElementById('custom-order-form');
const itemsContainer = document.getElementById('custom-items');
const addItemButton = document.getElementById('add-item');
const itemCount = document.getElementById('custom-item-count');
const totalOutput = document.getElementById('custom-total');
const statusBox = document.getElementById('custom-status');
const icNameInput = document.getElementById('custom-ic-name');
const phoneInput = document.getElementById('custom-phone');
const numberFormatter = new Intl.NumberFormat('de-DE');
const MAX_ITEMS = 10;
let nextItemId = 0;

function createItemRow() {
  const itemId = ++nextItemId;
  const row = document.createElement('div');
  row.className = 'item-row';
  row.innerHTML = `
    <div class="field">
      <label for="item-name-${itemId}">Gegenstand</label>
      <input id="item-name-${itemId}" data-item-name type="text" maxlength="80" placeholder="z. B. Gegenstand" required>
    </div>
    <div class="field">
      <label for="item-quantity-${itemId}">Menge</label>
      <input id="item-quantity-${itemId}" data-item-quantity type="number" min="1" max="10000" step="1" value="1" required>
    </div>
    <div class="field price-field">
      <label for="item-price-${itemId}">Preisvorschlag / Stück ($)</label>
      <input id="item-price-${itemId}" data-item-price type="number" min="1" max="1000000000" step="1" placeholder="Dein Vorschlag" required>
    </div>
    <button class="remove-item" type="button" aria-label="Gegenstand entfernen">×</button>
  `;
  return row;
}

function updateSummary() {
  const rows = [...itemsContainer.querySelectorAll('.item-row')];
  let total = 0;
  rows.forEach((row) => {
    const quantity = Math.max(0, Math.floor(Number(row.querySelector('[data-item-quantity]').value) || 0));
    const price = Math.max(0, Number(row.querySelector('[data-item-price]').value) || 0);
    total += quantity * price;
  });
  itemCount.textContent = String(rows.length);
  totalOutput.textContent = `${numberFormatter.format(total)} $`;
  addItemButton.disabled = rows.length >= MAX_ITEMS;
}

itemsContainer.append(createItemRow());
updateSummary();

addItemButton.addEventListener('click', () => {
  if (itemsContainer.children.length >= MAX_ITEMS) return;
  const row = createItemRow();
  itemsContainer.append(row);
  updateSummary();
  row.querySelector('[data-item-name]').focus();
});

itemsContainer.addEventListener('click', (event) => {
  const removeButton = event.target.closest('.remove-item');
  if (!removeButton) return;
  if (itemsContainer.children.length <= 1) {
    statusBox.textContent = 'Mindestens ein Gegenstand muss in der Bestellung bleiben.';
    statusBox.className = 'status error';
    return;
  }
  removeButton.closest('.item-row').remove();
  statusBox.textContent = '';
  statusBox.className = 'status';
  updateSummary();
});

itemsContainer.addEventListener('input', updateSummary);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const items = [...itemsContainer.querySelectorAll('.item-row')].map((row) => ({
    name: row.querySelector('[data-item-name]').value.trim(),
    quantity: Number(row.querySelector('[data-item-quantity]').value),
    pricePerItem: Number(row.querySelector('[data-item-price]').value)
  }));
  const icName = icNameInput.value.trim();
  const phone = phoneInput.value.trim();

  if (!icName || !phone || items.some(item =>
    !item.name || !Number.isSafeInteger(item.quantity) || item.quantity < 1
    || !Number.isSafeInteger(item.pricePerItem) || item.pricePerItem < 1
  )) {
    statusBox.textContent = 'Bitte prüfe deine Kontaktdaten und alle Bestellpositionen.';
    statusBox.className = 'status error';
    return;
  }

  statusBox.textContent = 'Bestellung wird gesendet...';
  statusBox.className = 'status';

  try {
    const response = await fetch('/api/wunsch-bestellung', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icName, phone, items })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      throw new Error(result.message || 'Bestellung konnte nicht gesendet werden.');
    }

    statusBox.textContent = result.message || `Bestellung gesendet. Preisvorschlag gesamt: ${numberFormatter.format(result.total)} $.`;
    statusBox.className = 'status success';
    form.reset();
    itemsContainer.replaceChildren(createItemRow());
    updateSummary();
  } catch (error) {
    statusBox.textContent = error.message || 'Fehler beim Senden der Bestellung.';
    statusBox.className = 'status error';
  }
});

const productsContainer = document.getElementById('products');
const count = document.getElementById('count');
const statusBox = document.getElementById('status');
const addButton = document.getElementById('add');
const saveButton = document.getElementById('save');
const MAX_PRODUCTS = 100;
let products = [];
let saved = [];
let loaded = false;

const clone = value => JSON.parse(JSON.stringify(value));
const dirty = () => JSON.stringify(products) !== JSON.stringify(saved);
const setStatus = (message, state = '') => { statusBox.textContent = message; statusBox.className = `status ${state}`.trim(); };

function makeId() {
  const base = `produkt-${Date.now().toString(36)}`;
  return `${base}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 80);
}

function refreshActions() {
  count.textContent = `${products.length} von ${MAX_PRODUCTS} Produkten`;
  addButton.disabled = !loaded || products.length >= MAX_PRODUCTS;
  saveButton.disabled = !loaded || !dirty();
}

function render() {
  productsContainer.replaceChildren();
  if (!products.length) {
    const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'Keine Ankaufprodukte vorhanden.'; productsContainer.append(empty);
  }
  products.forEach((product, index) => {
    const row = document.createElement('article'); row.className = 'product';
    row.innerHTML = `<label class="id">ID<input data-field="id" value=""></label><label>Name<input data-field="name" maxlength="80" value=""></label><label>Preis pro Stück ($)<input data-field="price" type="number" min="1" max="1000000000" step="1" value=""></label><button class="button remove" type="button">Entfernen</button>`;
    row.querySelector('[data-field="id"]').value = product.id;
    row.querySelector('[data-field="id"]').readOnly = true;
    row.querySelector('[data-field="name"]').value = product.name;
    row.querySelector('[data-field="price"]').value = product.price;
    row.querySelectorAll('input').forEach(input => input.addEventListener('input', () => {
      products[index][input.dataset.field] = input.dataset.field === 'price' ? input.value : input.value.trim();
      setStatus(dirty() ? 'Ungespeicherte Änderungen.' : 'Keine ungespeicherten Änderungen.'); refreshActions();
    }));
    row.querySelector('.remove').addEventListener('click', () => { products.splice(index, 1); render(); setStatus('Ungespeicherte Änderungen.'); refreshActions(); });
    productsContainer.append(row);
  });
  refreshActions();
}

async function load() {
  try {
    const response = await fetch('/api/admin/buyback-products');
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || !Array.isArray(result.products)) throw new Error(result.message || 'Ankaufprodukte konnten nicht geladen werden.');
    products = clone(result.products); saved = clone(result.products); loaded = true; render(); setStatus('Ankaufprodukte geladen.');
  } catch (error) { loaded = false; setStatus(error.message || 'Laden fehlgeschlagen.', 'error'); }
  refreshActions();
}

addButton.addEventListener('click', () => { products.push({ id: makeId(), name: '', price: '' }); render(); setStatus('Produkt hinzugefügt. Angaben ergänzen und speichern.'); });

saveButton.addEventListener('click', async () => {
  const normalized = products.map(product => ({ id: String(product.id || '').trim(), name: String(product.name || '').trim(), price: Number(product.price) }));
  const ids = new Set(normalized.map(product => product.id));
  if (normalized.some(product => !/^[a-z0-9-]{1,80}$/.test(product.id) || !product.name || product.name.length > 80 || !Number.isSafeInteger(product.price) || product.price < 1 || product.price > 1000000000) || ids.size !== normalized.length) {
    setStatus('Bitte prüfe ID, Name und Preis aller Produkte.', 'error'); return;
  }
  saveButton.disabled = true;
  try {
    const response = await fetch('/api/admin/buyback-products', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ products: normalized }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) throw new Error(result.message || 'Speichern fehlgeschlagen.');
    products = clone(result.products); saved = clone(result.products); render(); setStatus('Ankaufprodukte gespeichert.', 'success');
  } catch (error) { setStatus(error.message || 'Speichern fehlgeschlagen.', 'error'); }
  refreshActions();
});

load();

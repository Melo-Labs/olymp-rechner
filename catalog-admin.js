const productsContainer = document.getElementById('products');
const statusBox = document.getElementById('status');
let products = [];

function showStatus(message, state = '') {
  statusBox.textContent = message;
  statusBox.className = `status ${state}`.trim();
}

function makeField(labelText, value, className, type = 'text') {
  const wrapper = document.createElement('label');
  wrapper.className = `field ${className}`;
  const label = document.createElement('span');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  if (type === 'number') {
    input.min = '1';
    input.max = '1000000000';
    input.step = '1';
  } else if (type === 'text') {
    input.maxLength = className === 'description-field' ? 240 : 80;
  }
  wrapper.append(label, input);
  return { wrapper, input };
}

function renderProducts() {
  productsContainer.replaceChildren();
  if (!products.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Noch keine Produkte angelegt.';
    productsContainer.append(empty);
    return;
  }

  products.forEach((product, index) => {
    const row = document.createElement('article');
    row.className = 'product';
    const name = makeField('Produktname', product.name, 'name-field');
    const description = makeField('Beschreibung (optional)', product.description, 'description-field');
    const price = makeField('Festpreis ($)', product.price, 'price-field', 'number');
    const activeLabel = document.createElement('label');
    activeLabel.className = 'active';
    const active = document.createElement('input');
    active.type = 'checkbox';
    active.checked = product.active;
    const activeText = document.createElement('span');
    activeText.textContent = 'Aktiv';
    activeLabel.append(active, activeText);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete';
    remove.textContent = 'Entfernen';
    remove.setAttribute('aria-label', `${product.name || 'Produkt'} entfernen`);

    name.input.addEventListener('input', () => { products[index].name = name.input.value; });
    description.input.addEventListener('input', () => { products[index].description = description.input.value; });
    price.input.addEventListener('input', () => { products[index].price = price.input.value; });
    active.addEventListener('change', () => { products[index].active = active.checked; });
    remove.addEventListener('click', () => {
      products.splice(index, 1);
      renderProducts();
    });
    row.append(name.wrapper, description.wrapper, price.wrapper, activeLabel, remove);
    productsContainer.append(row);
  });
}

async function loadProducts() {
  try {
    const response = await fetch('/api/admin/shop-products');
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || !Array.isArray(result.products)) {
      throw new Error(result.message || 'Produkte konnten nicht geladen werden.');
    }
    products = result.products;
    renderProducts();
  } catch (error) {
    productsContainer.textContent = error.message || 'Produktkatalog konnte nicht geladen werden.';
    showStatus(error.message || 'Produktkatalog konnte nicht geladen werden.', 'error');
  }
}

document.getElementById('add-product').addEventListener('click', () => {
  if (products.length >= 200) {
    showStatus('Der Katalog kann höchstens 200 Produkte enthalten.', 'error');
    return;
  }
  products.push({ name: '', description: '', price: '', active: true });
  renderProducts();
  productsContainer.lastElementChild.querySelector('input').focus();
});

document.getElementById('save-products').addEventListener('click', async () => {
  const saveButton = document.getElementById('save-products');
  const normalized = products.map(product => ({
    id: product.id,
    name: String(product.name || '').trim(),
    description: String(product.description || '').trim(),
    price: Number(product.price),
    active: Boolean(product.active)
  }));
  if (normalized.some(product => !product.name || !Number.isSafeInteger(product.price) || product.price < 1)) {
    showStatus('Bitte gib für jedes Produkt einen Namen und einen positiven ganzzahligen Festpreis ein.', 'error');
    return;
  }

  saveButton.disabled = true;
  showStatus('Änderungen werden gespeichert …');
  try {
    const response = await fetch('/api/admin/shop-products', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ products: normalized })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || !Array.isArray(result.products)) {
      throw new Error(result.message || 'Änderungen konnten nicht gespeichert werden.');
    }
    products = result.products;
    renderProducts();
    if (result.auditLogged === false) {
      showStatus(result.warning || 'Produkte wurden gespeichert, aber das Discord-Audit konnte nicht gesendet werden.', 'error');
    } else if (result.auditChangeCount === 0) {
      showStatus('Katalog gespeichert; es gab keine Änderungen zu protokollieren.', 'success');
    } else {
      showStatus('Produkte gespeichert und Änderungen im Discord-Audit protokolliert.', 'success');
    }
  } catch (error) {
    showStatus(error.message || 'Speichern fehlgeschlagen.', 'error');
  } finally {
    saveButton.disabled = false;
  }
});

loadProducts();

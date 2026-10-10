const form = document.getElementById('custom-order-form');
const productsContainer = document.getElementById('shop-products');
const cartContainer = document.getElementById('custom-items');
const itemCount = document.getElementById('custom-item-count');
const totalOutput = document.getElementById('custom-total');
const statusBox = document.getElementById('custom-status');
const customStatus = document.getElementById('custom-item-status');
const icNameInput = document.getElementById('custom-ic-name');
const phoneInput = document.getElementById('custom-phone');
const shopSearchInput = document.getElementById('shop-search');
const submitButton = form.querySelector('[type="submit"]');
const numberFormatter = new Intl.NumberFormat('de-DE');
const MAX_ITEMS = 10;
let products = [];
let cart = [];

function formatPrice(value) {
  return `${numberFormatter.format(value)} $`;
}

function addToCart(item) {
  const existing = cart.find(entry => entry.type === item.type
    && (item.type === 'catalog' ? entry.productId === item.productId : entry.name.toLocaleLowerCase() === item.name.toLocaleLowerCase()
      && entry.pricePerItem === item.pricePerItem));
  if (existing) {
    existing.quantity = Math.min(10000, existing.quantity + item.quantity);
  } else if (cart.length < MAX_ITEMS) {
    cart.push(item);
  } else {
    customStatus.textContent = `Der Warenkorb kann höchstens ${MAX_ITEMS} verschiedene Positionen enthalten.`;
    customStatus.className = 'status error';
    return false;
  }
  renderCart();
  customStatus.textContent = '';
  customStatus.className = 'status';
  return true;
}

function getVisibleProducts() {
  const query = (shopSearchInput?.value || '').trim().toLowerCase();
  if (!query) return products;
  return products.filter(product => {
    const haystack = `${product.name || ''} ${product.description || ''}`.toLowerCase();
    return haystack.includes(query);
  });
}

function renderProducts() {
  productsContainer.replaceChildren();
  const visibleProducts = getVisibleProducts();
  if (!visibleProducts.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Keine Produkte gefunden. Versuche eine andere Suche oder füge einen Wunsch hinzu.';
    productsContainer.append(empty);
    return;
  }

  visibleProducts.forEach(product => {
    const card = document.createElement('article');
    card.className = 'shop-product';

    const visual = document.createElement('div');
    visual.className = 'product-visual';
    if (product.image) {
      const image = document.createElement('img');
      image.src = product.image;
      image.alt = product.name;
      visual.append(image);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'product-visual-placeholder';
      placeholder.textContent = (product.name || 'P').slice(0, 2).toUpperCase();
      visual.append(placeholder);
    }

    const body = document.createElement('div');
    body.className = 'product-body';

    const titleRow = document.createElement('div');
    titleRow.className = 'product-title-row';
    const title = document.createElement('h3');
    title.textContent = product.name;
    const price = document.createElement('strong');
    price.className = 'shop-price';
    price.textContent = formatPrice(product.price);
    titleRow.append(title, price);

    body.append(titleRow);
    if (product.description) {
      const description = document.createElement('p');
      description.textContent = product.description;
      body.append(description);
    }

    const addButton = document.createElement('button');
    addButton.className = 'shop-add';
    addButton.type = 'button';
    addButton.textContent = 'In den Warenkorb';
    addButton.addEventListener('click', () => {
      addToCart({ type: 'catalog', productId: product.id, name: product.name, pricePerItem: product.price, quantity: 1 });
    });

    card.append(visual, body, addButton);
    productsContainer.append(card);
  });
}

function renderCart() {
  cartContainer.replaceChildren();
  if (!cart.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Dein Warenkorb ist noch leer.';
    cartContainer.append(empty);
  }

  let total = 0;
  cart.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'cart-row';
    const details = document.createElement('div');
    const name = document.createElement('h3');
    name.textContent = item.name;
    details.append(name);
    const unitPrice = document.createElement('p');
    unitPrice.textContent = `${item.type === 'custom' ? 'Preisvorschlag' : 'Festpreis'}: ${formatPrice(item.pricePerItem)} pro Stück`;
    details.append(unitPrice);

    const quantity = document.createElement('input');
    quantity.type = 'number';
    quantity.min = '1';
    quantity.max = '10000';
    quantity.step = '1';
    quantity.value = String(item.quantity);
    quantity.setAttribute('aria-label', `Menge für ${item.name}`);
    quantity.addEventListener('change', () => {
      const nextQuantity = Number(quantity.value);
      if (!Number.isSafeInteger(nextQuantity) || nextQuantity < 1 || nextQuantity > 10000) {
        quantity.value = String(item.quantity);
        return;
      }
      cart[index].quantity = nextQuantity;
      renderCart();
    });

    const lineTotal = document.createElement('strong');
    lineTotal.className = 'line-price';
    const itemTotal = item.quantity * item.pricePerItem;
    lineTotal.textContent = formatPrice(itemTotal);
    total += itemTotal;

    const remove = document.createElement('button');
    remove.className = 'remove-item';
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `${item.name} aus dem Warenkorb entfernen`);
    remove.addEventListener('click', () => {
      cart.splice(index, 1);
      renderCart();
    });
    row.append(details, quantity, lineTotal, remove);
    cartContainer.append(row);
  });

  itemCount.textContent = String(cart.length);
  totalOutput.textContent = formatPrice(total);
  submitButton.disabled = cart.length === 0;
}

document.getElementById('add-custom-item').addEventListener('click', () => {
  const nameInput = document.getElementById('custom-name');
  const quantityInput = document.getElementById('custom-quantity');
  const priceInput = document.getElementById('custom-price');
  const name = nameInput.value.trim();
  const quantity = Number(quantityInput.value);
  const pricePerItem = Number(priceInput.value);
  if (!name || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000
    || !Number.isSafeInteger(pricePerItem) || pricePerItem < 1 || pricePerItem > 1000000000) {
    customStatus.textContent = 'Bitte Gegenstand, gültige Menge und Preisvorschlag eingeben.';
    customStatus.className = 'status error';
    return;
  }
  if (addToCart({ type: 'custom', name, quantity, pricePerItem })) {
    nameInput.value = '';
    quantityInput.value = '1';
    priceInput.value = '';
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity() || !cart.length) return;

  const items = cart.map(item => item.type === 'catalog'
    ? { type: 'catalog', productId: item.productId, quantity: item.quantity }
    : { type: 'custom', name: item.name, quantity: item.quantity, pricePerItem: item.pricePerItem });
  const icName = icNameInput.value.trim();
  const phone = phoneInput.value.trim();
  statusBox.textContent = 'Bestellung wird gesendet...';
  statusBox.className = 'status';
  submitButton.disabled = true;

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

    statusBox.textContent = result.message || `Bestellung gesendet. Gesamt: ${formatPrice(result.total)}.`;
    statusBox.className = 'status success';
    form.reset();
    cart = [];
    renderCart();
  } catch (error) {
    statusBox.textContent = error.message || 'Fehler beim Senden der Bestellung.';
    statusBox.className = 'status error';
    submitButton.disabled = cart.length === 0;
  }
});

async function loadProducts() {
  try {
    const response = await fetch('/api/shop/products');
    const result = await response.json();
    if (!response.ok || result.ok !== true || !Array.isArray(result.products)) {
      throw new Error(result.message || 'Produkte konnten nicht geladen werden.');
    }
    products = result.products;
    renderProducts();
  } catch (error) {
    productsContainer.replaceChildren();
    const message = document.createElement('p');
    message.className = 'status error';
    message.textContent = error.message || 'Produktkatalog konnte nicht geladen werden.';
    productsContainer.append(message);
  }
}

shopSearchInput.addEventListener('input', renderProducts);

renderCart();
loadProducts();

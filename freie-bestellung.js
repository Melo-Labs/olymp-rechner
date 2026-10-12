const form = document.getElementById('custom-order-form');
const productsContainer = document.getElementById('shop-products');
const offersContainer = document.getElementById('shop-offers');
const adsContainer = document.getElementById('shop-ads');
const adList = document.getElementById('shop-ad-list');
const cartCount = document.getElementById('shop-cart-count');
const catalogTitle = document.getElementById('catalog-title');
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
let weeklyBundle = null;
let adRotationTimer = null;

function formatPrice(value) {
  return `${numberFormatter.format(value)} $`;
}

function addToCart(item) {
  const existing = cart.find(entry => entry.type === item.type
    && (item.type === 'catalog' ? entry.productId === item.productId
      : item.type === 'weeklyOffer' ? entry.weeklyOfferId === item.weeklyOfferId
        : entry.name.toLocaleLowerCase() === item.name.toLocaleLowerCase() && entry.pricePerItem === item.pricePerItem));
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
    const haystack = `${product.name || ''} ${product.description || ''} ${product.category || ''}`.toLowerCase();
    return haystack.includes(query);
  });
}

function renderProducts() {
  productsContainer.replaceChildren();
  const visibleProducts = getVisibleProducts();
  const hasSearch = Boolean(shopSearchInput.value.trim());
  const offerProducts = hasSearch ? [] : visibleProducts.filter(product => product.promotion);
  const catalogProducts = hasSearch ? visibleProducts : visibleProducts.filter(product => !product.promotion);
  offersContainer.replaceChildren();
  offersContainer.closest('.shop-section').hidden = hasSearch;
  catalogTitle.textContent = hasSearch ? 'Suchergebnisse' : offerProducts.length ? 'Weitere Produkte' : 'Alle Produkte';

  if (offerProducts.length) {
    offerProducts.forEach(product => offersContainer.append(createProductCard(product)));
  }
  if (weeklyBundle && !hasSearch) {
    renderWeeklyBundle();
  }

  if (!catalogProducts.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = hasSearch
      ? 'Keine Produkte gefunden. Versuche eine andere Suche oder füge einen Wunsch hinzu.'
      : 'Alle aktuellen Angebote findest du oben.';
    productsContainer.append(empty);
    return;
  }

  const grouped = new Map();
  for (const product of catalogProducts) {
    const categoryName = product.category || 'Allgemein';
    if (!grouped.has(categoryName)) grouped.set(categoryName, []);
    grouped.get(categoryName).push(product);
  }

  const sortedCategories = [...grouped.keys()].sort((a, b) => {
    if (a === 'Allgemein') return -1;
    if (b === 'Allgemein') return 1;
    return a.localeCompare(b, 'de', { sensitivity: 'base' });
  });

  sortedCategories.forEach(categoryName => {
    const group = document.createElement('div');
    group.className = 'shop-category-group';

    const heading = document.createElement('h3');
    heading.className = 'shop-category-title';
    heading.textContent = categoryName;
    group.append(heading);

    const list = document.createElement('div');
    list.className = 'shop-category-list';

    grouped.get(categoryName)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'de', { sensitivity: 'base' }))
      .forEach(product => list.append(createProductCard(product)));

    group.append(list);
    productsContainer.append(group);
  });
}

function renderWeeklyBundle() {
  const offer = document.createElement('div');
  offer.className = 'weekly-offer-purchase';
  const price = document.createElement('strong');
  price.className = 'shop-price';
  price.textContent = formatPrice(weeklyBundle.price);
  const button = document.createElement('button');
  button.className = 'shop-add';
  button.type = 'button';
  button.textContent = 'In den Warenkorb';
  button.addEventListener('click', () => addToCart({
    type: 'weeklyOffer',
    weeklyOfferId: weeklyBundle.id,
    name: weeklyBundle.name,
    pricePerItem: weeklyBundle.price,
    quantity: 1
  }));
  offer.append(price, button);
  offersContainer.append(offer);
}

function createProductCard(product) {
  const isAvailable = Boolean(product.available);
  const priceValue = product.promotion?.price ?? product.price;
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
  if (product.promotion) {
    const badge = document.createElement('span');
    badge.className = 'deal-badge';
    badge.textContent = product.promotion.label;
    body.append(badge);
  }

  const titleRow = document.createElement('div');
  titleRow.className = 'product-title-row';
  const title = document.createElement('h3');
  title.textContent = product.name;
  const price = document.createElement('strong');
  price.className = 'shop-price';
  price.textContent = formatPrice(priceValue);
  titleRow.append(title, price);
  body.append(titleRow);

  if (product.promotion) {
    const originalPrice = document.createElement('del');
    originalPrice.className = 'original-price';
    originalPrice.textContent = formatPrice(product.price);
    const saving = document.createElement('span');
    saving.className = 'deal-saving';
    saving.textContent = `Du sparst ${formatPrice(product.price - priceValue)}`;
    body.append(originalPrice, saving);
  }

  const availability = document.createElement('p');
  availability.className = 'product-stock';
  availability.textContent = isAvailable ? 'Verfügbar' : 'Ausverkauft';
  body.append(availability);

  const addButton = document.createElement('button');
  addButton.className = 'shop-add';
  addButton.type = 'button';
  addButton.disabled = !isAvailable;
  addButton.textContent = isAvailable ? 'In den Warenkorb' : 'Ausverkauft';
  addButton.addEventListener('click', () => {
    if (!isAvailable) return;
    addToCart({ type: 'catalog', productId: product.id, name: product.name, pricePerItem: priceValue, quantity: 1 });
  });

  card.append(visual, body, addButton);
  return card;
}

function renderAds(ads) {
  adList.replaceChildren();
  const validAds = ads.filter(ad => ad.title && (ad.href || ad.image));
  if (adRotationTimer) {
    clearInterval(adRotationTimer);
    adRotationTimer = null;
  }
  if (!validAds.length) {
    const placeholder = document.createElement('p');
    placeholder.className = 'shop-ad-placeholder';
    placeholder.textContent = 'Hier könnte Ihre Werbung stehen. Bei Interesse bitte ansprechen.';
    adList.append(placeholder);
    return;
  }
  let activeIndex = 0;
  const slides = [];
  const pagination = document.createElement('div');
  pagination.className = 'shop-ad-pagination';
  pagination.setAttribute('aria-label', 'Werbeanzeigen auswählen');
  const dots = [];

  function showAd(index) {
    activeIndex = (index + validAds.length) % validAds.length;
    slides.forEach((slide, slideIndex) => {
      slide.hidden = slideIndex !== activeIndex;
      dots[slideIndex].setAttribute('aria-current', String(slideIndex === activeIndex));
    });
  }

  validAds.forEach((ad, index) => {
    const slide = document.createElement(ad.href ? 'a' : 'div');
    slide.className = 'shop-ad';
    if (ad.href) {
      slide.href = ad.href;
      slide.target = '_blank';
      slide.rel = 'noopener noreferrer';
    }
    slide.hidden = index !== 0;
    if (ad.image) {
      const image = document.createElement('img');
      image.src = ad.image;
      image.alt = ad.title;
      slide.append(image);
    }
    const title = document.createElement('strong');
    title.textContent = ad.title;
    slide.append(title);
    if (ad.text) {
      const text = document.createElement('span');
      text.textContent = ad.text;
      slide.append(text);
    }
    if (ad.linkLabel) {
      const linkLabel = document.createElement('em');
      linkLabel.textContent = ad.linkLabel;
      slide.append(linkLabel);
    }
    slides.push(slide);
    adList.append(slide);
    if (validAds.length > 1) {
      const dot = document.createElement('button');
      dot.className = 'shop-ad-dot';
      dot.type = 'button';
      dot.setAttribute('aria-label', `Anzeige ${index + 1} anzeigen`);
      dot.setAttribute('aria-current', String(index === 0));
      dot.addEventListener('click', () => showAd(index));
      dots.push(dot);
      pagination.append(dot);
    }
  });
  if (dots.length) adList.append(pagination);
  if (validAds.length > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    adRotationTimer = setInterval(() => showAd(activeIndex + 1), 6000);
  }
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
  cartCount.textContent = String(cart.length);
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
    : item.type === 'weeklyOffer'
      ? { type: 'weeklyOffer', weeklyOfferId: item.weeklyOfferId, quantity: item.quantity }
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
    weeklyBundle = result.weeklyBundle || null;
    renderAds(Array.isArray(result.ads) ? result.ads : []);
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

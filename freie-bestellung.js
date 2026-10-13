const form = document.getElementById('custom-order-form');
const productsContainer = document.getElementById('shop-products');
const adList = document.getElementById('shop-ad-list');
const cartCount = document.getElementById('shop-cart-count');
const cartCountLabel = document.querySelector('.header-action[href="#cart-section"]');
const wishlistCountHeader = document.getElementById('shop-wishlist-count');
const wishlistCountLabel = document.querySelector('.header-action[href="#wishlist-panel"]');
const catalogStatus = document.getElementById('catalog-status');
const catalogTitle = document.getElementById('catalog-title');
const resultCount = document.getElementById('catalog-result-count');
const categoryFilters = document.getElementById('category-filters');
const sortSelect = document.getElementById('product-sort');
const shopSearchInput = document.getElementById('shop-search');
const feedback = document.getElementById('shop-feedback');
const feedbackMessage = document.getElementById('shop-feedback-message');
const feedbackContext = document.getElementById('shop-feedback-context');
const noResultsPanel = document.getElementById('no-results-panel');
const noResultsQuery = document.getElementById('no-results-query');
const noResultsCopy = document.getElementById('no-results-copy');
const noResultsWishButton = document.getElementById('no-results-wish');
const weeklyBundleSection = document.getElementById('weekly-offers');
const weeklyBundleAddButton = document.getElementById('weekly-bundle-add');
const weeklyBundlePrice = document.getElementById('weekly-bundle-price');
const cartContainer = document.getElementById('custom-items');
const itemCount = document.getElementById('custom-item-count');
const totalOutput = document.getElementById('custom-total');
const statusBox = document.getElementById('custom-status');
const customStatus = document.getElementById('custom-item-status');
const storageStatus = document.getElementById('storage-status');
const orderNote = document.getElementById('order-note');
const icNameInput = document.getElementById('custom-ic-name');
const phoneInput = document.getElementById('custom-phone');
const customNameInput = document.getElementById('custom-name');
const customQuantityInput = document.getElementById('custom-quantity');
const customPriceInput = document.getElementById('custom-price');
const submitButton = form.querySelector('[type="submit"]');
const numberFormatter = new Intl.NumberFormat('de-DE');
const MAX_ITEMS = 10;
const MAX_QUANTITY = 10000;
const CART_STORAGE_KEY = 'olymp-shop-cart-v1';
const WISHLIST_STORAGE_KEY = 'olymp-shop-wishlist-v1';

let products = [];
let cart = [];
let weeklyBundle = null;
let activeCategory = '';
let adRotationTimer = null;
let feedbackTimer = null;
let storageAvailable = true;
let wishlistIds = readStoredWishlist();

function formatPrice(value) {
  return `${numberFormatter.format(value)} $`;
}

function isValidQuantity(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_QUANTITY;
}

function markStorageUnavailable() {
  storageAvailable = false;
  storageStatus.hidden = false;
  storageStatus.classList.add('warning');
  storageStatus.textContent = 'Browser-Speicher nicht verfügbar – Merkliste und Warenkorb bleiben nur bis zum Neuladen oder Schließen dieses Tabs erhalten.';
}

function readStoredJson(key) {
  let value;
  try {
    value = localStorage.getItem(key);
  } catch {
    markStorageUnavailable();
    return null;
  }
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      markStorageUnavailable();
    }
    return null;
  }
}

function writeStoredJson(key, value) {
  if (!storageAvailable) return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    markStorageUnavailable();
    return false;
  }
}

function readStoredWishlist() {
  const stored = readStoredJson(WISHLIST_STORAGE_KEY);
  if (!Array.isArray(stored)) return [];
  return [...new Set(stored.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 100))].slice(0, 200);
}

function readStoredCart() {
  const stored = readStoredJson(CART_STORAGE_KEY);
  if (!Array.isArray(stored)) return [];

  const validItems = [];
  for (const entry of stored.slice(0, MAX_ITEMS)) {
    if (!entry || !isValidQuantity(entry.quantity)) continue;
    if (entry.type === 'catalog' && typeof entry.productId === 'string' && entry.productId.length <= 100) {
      validItems.push({ type: 'catalog', productId: entry.productId, quantity: entry.quantity });
    } else if (entry.type === 'weeklyOffer' && typeof entry.weeklyOfferId === 'string' && entry.weeklyOfferId.length <= 100) {
      validItems.push({ type: 'weeklyOffer', weeklyOfferId: entry.weeklyOfferId, quantity: entry.quantity });
    } else if (entry.type === 'custom'
      && typeof entry.name === 'string' && entry.name.trim().length > 0 && entry.name.trim().length <= 80
      && Number.isSafeInteger(entry.pricePerItem) && entry.pricePerItem >= 1 && entry.pricePerItem <= 1000000000) {
      validItems.push({
        type: 'custom',
        name: entry.name.trim(),
        pricePerItem: entry.pricePerItem,
        quantity: entry.quantity
      });
    }
  }
  return validItems;
}

function persistCart() {
  const safeItems = cart.map(item => item.type === 'catalog'
    ? { type: 'catalog', productId: item.productId, quantity: item.quantity }
    : item.type === 'weeklyOffer'
      ? { type: 'weeklyOffer', weeklyOfferId: item.weeklyOfferId, quantity: item.quantity }
      : { type: 'custom', name: item.name, pricePerItem: item.pricePerItem, quantity: item.quantity });
  writeStoredJson(CART_STORAGE_KEY, safeItems);
}

function persistWishlist() {
  writeStoredJson(WISHLIST_STORAGE_KEY, wishlistIds);
}

function getProductPrice(product) {
  return product.promotion?.price ?? product.price;
}

function renderCategoryFilters() {
  const categories = [...new Set(products.map(product => product.category || 'Allgemein'))]
    .sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
  categoryFilters.replaceChildren();
  const allButton = document.createElement('button');
  allButton.className = 'filter-pill';
  allButton.type = 'button';
  allButton.dataset.category = '';
  allButton.textContent = `Alle Artikel ${products.length}`;
  allButton.setAttribute('aria-pressed', String(activeCategory === ''));
  allButton.addEventListener('click', () => {
    activeCategory = '';
    updateCategoryFilterState();
    renderProducts();
  });
  categoryFilters.append(allButton);

  const addFilterButton = (label, category) => {
    const button = document.createElement('button');
    button.className = 'filter-pill';
    button.type = 'button';
    button.dataset.category = category;
    button.setAttribute('aria-pressed', String(activeCategory === category));
    button.textContent = `${label} ${products.filter(product => (product.category || 'Allgemein') === category).length}`;
    button.addEventListener('click', () => {
      activeCategory = category;
      updateCategoryFilterState();
      renderProducts();
    });
    categoryFilters.append(button);
  };

  categories.forEach(category => addFilterButton(category, category));
}

function updateCategoryFilterState() {
  categoryFilters.querySelectorAll('[data-category]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.category === activeCategory));
  });
}

function getVisibleProducts() {
  const query = shopSearchInput.value.trim().toLocaleLowerCase('de');
  const filtered = products.filter(product => {
    const category = product.category || 'Allgemein';
    const matchesCategory = !activeCategory || category === activeCategory;
    const searchableText = `${product.name || ''} ${product.description || ''} ${category}`.toLocaleLowerCase('de');
    return matchesCategory && (!query || searchableText.includes(query));
  });

  const sortMode = sortSelect.value;
  filtered.sort((a, b) => {
    if (sortMode === 'price-asc') return getProductPrice(a) - getProductPrice(b) || a.name.localeCompare(b.name, 'de');
    if (sortMode === 'price-desc') return getProductPrice(b) - getProductPrice(a) || a.name.localeCompare(b.name, 'de');
    return String(a.name).localeCompare(String(b.name), 'de', { sensitivity: 'base' });
  });
  return filtered;
}

function renderProducts() {
  if (!productsContainer) return;
  productsContainer.replaceChildren();
  const visibleProducts = getVisibleProducts();
  const query = shopSearchInput.value.trim();
  const sortLabels = {
    'name-asc': 'alphabetisch',
    'price-asc': 'Preis aufsteigend',
    'price-desc': 'Preis absteigend'
  };
  const categoryLabel = activeCategory ? ` · ${activeCategory}` : '';
  catalogTitle.textContent = query ? 'Suchergebnisse' : activeCategory || 'Alle Produkte';
  resultCount.textContent = query
    ? `${visibleProducts.length} ${visibleProducts.length === 1 ? 'Treffer' : 'Treffer'}${categoryLabel}`
    : `${visibleProducts.length} Artikel · ${sortLabels[sortSelect.value]}${categoryLabel}`;

  const showBundle = Boolean(weeklyBundle) && !query;
  weeklyBundleSection.hidden = !showBundle;
  if (!visibleProducts.length) {
    const empty = document.createElement('p');
    empty.className = 'no-products';
    empty.textContent = query
      ? `Keine Produkte für „${query}“ gefunden. Du kannst den Gegenstand als Wunschartikel zur aktuellen Bestellung hinzufügen.`
      : 'In dieser Kategorie sind aktuell keine Produkte verfügbar.';
    productsContainer.append(empty);
    updateNoResultsPanel(query);
    return;
  }

  visibleProducts.forEach(product => productsContainer.append(createProductCard(product)));
  noResultsPanel.hidden = true;
}

function updateNoResultsPanel(query) {
  const hasNoResults = Boolean(query) && getVisibleProducts().length === 0;
  noResultsPanel.hidden = !hasNoResults;
  if (!hasNoResults) return;
  noResultsQuery.textContent = `„${query}“`;
  noResultsCopy.textContent = `Keine Produkte für „${query}“ gefunden.`;
  noResultsPanel.dataset.query = query;
}

function createProductCard(product) {
  const priceValue = getProductPrice(product);
  const isAvailable = Boolean(product.available);
  const card = document.createElement('article');
  card.className = 'shop-product';

  const topLine = document.createElement('div');
  topLine.className = 'product-topline';
  const category = document.createElement('span');
  category.className = 'category-tag';
  category.textContent = product.category || 'Allgemein';

  const favorite = document.createElement('button');
  favorite.className = 'favorite-toggle';
  favorite.type = 'button';
  favorite.dataset.productId = product.id;
  favorite.setAttribute('aria-pressed', String(wishlistIds.includes(product.id)));
  favorite.setAttribute('aria-label', wishlistIds.includes(product.id)
    ? `${product.name} aus der Merkliste entfernen`
    : `${product.name} in der Merkliste speichern`);
  favorite.title = favorite.getAttribute('aria-label');
  favorite.textContent = wishlistIds.includes(product.id) ? '♥' : '♡';
  favorite.addEventListener('click', () => toggleWishlist(product, favorite));
  topLine.append(category, favorite);

  const visual = document.createElement('div');
  visual.className = 'product-image';
  if (product.image) {
    const image = document.createElement('img');
    image.src = product.image;
    image.alt = product.name;
    image.loading = 'lazy';
    visual.append(image);
  } else {
    const fallback = document.createElement('span');
    fallback.className = 'product-image-fallback';
    fallback.textContent = (product.name || 'P').slice(0, 2).toUpperCase();
    visual.append(fallback);
  }

  const title = document.createElement('h3');
  title.textContent = product.name;
  const priceRow = document.createElement('div');
  priceRow.className = 'product-price-row';
  const price = document.createElement('strong');
  price.className = 'shop-price';
  price.textContent = formatPrice(priceValue);
  const availability = document.createElement('span');
  availability.className = `product-stock${isAvailable ? '' : ' unavailable'}`;
  availability.textContent = isAvailable ? 'Verfügbar' : 'Ausverkauft';
  priceRow.append(price, availability);

  card.append(topLine, visual);
  if (product.promotion) {
    const badge = document.createElement('span');
    badge.className = 'deal-badge';
    badge.textContent = product.promotion.label || 'Wochenangebot';
    card.append(badge);
  }
  card.append(title, priceRow);

  if (product.promotion) {
    const originalPrice = document.createElement('del');
    originalPrice.className = 'original-price';
    originalPrice.textContent = formatPrice(product.price);
    const saving = document.createElement('span');
    saving.className = 'deal-saving';
    saving.textContent = `Du sparst ${formatPrice(product.price - priceValue)}`;
    card.append(originalPrice, saving);
  }

  const buyRow = document.createElement('div');
  buyRow.className = 'product-buy';
  const note = document.createElement('span');
  note.className = 'product-note';
  note.textContent = product.promotion ? 'Aktionspreis' : 'Festpreis';
  const addButton = document.createElement('button');
  addButton.className = 'btn-gold';
  addButton.type = 'button';
  addButton.disabled = !isAvailable;
  addButton.textContent = isAvailable ? 'In den Warenkorb +' : 'Ausverkauft';
  addButton.setAttribute('aria-label', `${product.name} in den Warenkorb legen, ${formatPrice(priceValue)}`);
  addButton.addEventListener('click', () => {
    if (!isAvailable) return;
    addToCart({
      type: 'catalog',
      productId: product.id,
      name: product.name,
      image: product.image || '',
      pricePerItem: priceValue,
      quantity: 1
    });
  });
  buyRow.append(note, addButton);
  card.append(buyRow);
  return card;
}

function toggleWishlist(product, button) {
  const isSaved = wishlistIds.includes(product.id);
  wishlistIds = isSaved
    ? wishlistIds.filter(id => id !== product.id)
    : [...wishlistIds, product.id];
  persistWishlist();
  syncWishlistButtons();
  renderWishlist();
  updateWishlistCount();
  showCartFeedback(isSaved
    ? `${product.name} aus der Merkliste entfernt.`
    : `${product.name} in der Merkliste gespeichert.`, 'Merkliste nur auf diesem Gerät');
  button.focus({ preventScroll: true });
}

function syncWishlistButtons() {
  document.querySelectorAll('.favorite-toggle[data-product-id]').forEach(button => {
    const productId = button.dataset.productId;
    const product = products.find(item => item.id === productId);
    const saved = wishlistIds.includes(productId);
    button.setAttribute('aria-pressed', String(saved));
    button.setAttribute('aria-label', saved
      ? `${product?.name || 'Artikel'} aus der Merkliste entfernen`
      : `${product?.name || 'Artikel'} in der Merkliste speichern`);
    button.title = button.getAttribute('aria-label');
    button.textContent = saved ? '♥' : '♡';
  });
}

function updateWishlistCount() {
  wishlistCountHeader.textContent = String(wishlistIds.length);
  document.getElementById('wishlist-count').textContent = `${wishlistIds.length} gespeichert`;
  wishlistCountLabel.setAttribute('aria-label', `Merkliste, ${wishlistIds.length} Artikel`);
}

function renderWishlist() {
  const container = document.getElementById('wishlist-items');
  container.replaceChildren();
  const savedProducts = wishlistIds
    .map(id => products.find(product => product.id === id))
    .filter(Boolean);

  if (!savedProducts.length) {
    const empty = document.createElement('p');
    empty.className = 'wishlist-empty';
    empty.textContent = 'Noch keine Artikel gemerkt. Nutze das Herz an einem Produkt, um es hier zu speichern.';
    container.append(empty);
    updateWishlistCount();
    return;
  }

  savedProducts.forEach(product => {
    const row = document.createElement('div');
    row.className = 'saved-row';
    if (product.image) {
      const image = document.createElement('img');
      image.src = product.image;
      image.alt = '';
      image.loading = 'lazy';
      row.append(image);
    }
    const copy = document.createElement('span');
    copy.className = 'saved-row-copy';
    const name = document.createElement('strong');
    name.textContent = product.name;
    const price = document.createElement('span');
    price.textContent = `${formatPrice(getProductPrice(product))} · ${product.available ? 'Verfügbar' : 'Ausverkauft'}`;
    copy.append(name, price);

    const actions = document.createElement('span');
    actions.className = 'saved-row-actions';
    const add = document.createElement('button');
    add.className = 'wishlist-add';
    add.type = 'button';
    add.textContent = '+';
    add.title = `${product.name} in den Warenkorb legen`;
    add.setAttribute('aria-label', `${product.name} aus der Merkliste in den Warenkorb legen`);
    add.disabled = !product.available;
    add.addEventListener('click', () => addToCart({
      type: 'catalog', productId: product.id, name: product.name, image: product.image || '',
      pricePerItem: getProductPrice(product), quantity: 1
    }));

    const remove = document.createElement('button');
    remove.className = 'wishlist-remove';
    remove.type = 'button';
    remove.textContent = '♥';
    remove.title = `${product.name} aus der Merkliste entfernen`;
    remove.setAttribute('aria-label', `${product.name} aus der Merkliste entfernen`);
    remove.addEventListener('click', () => {
      wishlistIds = wishlistIds.filter(id => id !== product.id);
      persistWishlist();
      syncWishlistButtons();
      renderWishlist();
      showCartFeedback(`${product.name} aus der Merkliste entfernt.`, 'Merkliste nur auf diesem Gerät');
    });
    actions.append(add, remove);
    row.append(copy, actions);
    container.append(row);
  });
  updateWishlistCount();
}

function renderWeeklyBundle() {
  if (!weeklyBundle) {
    weeklyBundleAddButton.disabled = true;
    return;
  }
  weeklyBundlePrice.textContent = formatPrice(weeklyBundle.price);
  weeklyBundleAddButton.disabled = false;
  weeklyBundleAddButton.onclick = () => addToCart({
    type: 'weeklyOffer',
    weeklyOfferId: weeklyBundle.id,
    name: weeklyBundle.name,
    image: '/img/wochenangebot.png',
    pricePerItem: weeklyBundle.price,
    quantity: 1
  });
}

function showCartFeedback(message, context = '') {
  feedbackMessage.textContent = message;
  feedbackContext.textContent = context;
  feedback.classList.remove('error');
  feedback.hidden = false;
  if (feedbackTimer) window.clearTimeout(feedbackTimer);
  feedbackTimer = window.setTimeout(() => {
    feedback.hidden = true;
    feedbackTimer = null;
  }, 5000);
}

function addToCart(item) {
  const existing = cart.find(entry => entry.type === item.type
    && (item.type === 'catalog' ? entry.productId === item.productId
      : item.type === 'weeklyOffer' ? entry.weeklyOfferId === item.weeklyOfferId
        : entry.name.toLocaleLowerCase('de') === item.name.toLocaleLowerCase('de') && entry.pricePerItem === item.pricePerItem));

  if (existing) {
    existing.quantity = Math.min(MAX_QUANTITY, existing.quantity + item.quantity);
  } else if (cart.length < MAX_ITEMS) {
    cart.push(item);
  } else {
    customStatus.textContent = `Der Warenkorb kann höchstens ${MAX_ITEMS} verschiedene Positionen enthalten.`;
    customStatus.className = 'status error';
    showCartFeedback(`Der Warenkorb ist auf ${MAX_ITEMS} verschiedene Positionen begrenzt.`, 'Entferne zuerst eine Position.');
    feedback.classList.add('error');
    return false;
  }

  persistCart();
  renderCart();
  customStatus.textContent = '';
  customStatus.className = 'status';
  showCartFeedback(`${item.name} wurde in den Warenkorb gelegt.`, `Warenkorb oben aktualisiert · ${cart.length} ${cart.length === 1 ? 'Position' : 'Positionen'}`);
  return true;
}

function restoreCartFromStorage() {
  const savedItems = readStoredCart();
  cart = savedItems.map(entry => {
    if (entry.type === 'catalog') {
      const product = products.find(item => item.id === entry.productId && item.available);
      if (!product) return null;
      return {
        type: 'catalog', productId: product.id, name: product.name,
        image: product.image || '', pricePerItem: getProductPrice(product), quantity: entry.quantity
      };
    }
    if (entry.type === 'weeklyOffer') {
      if (!weeklyBundle || weeklyBundle.id !== entry.weeklyOfferId) return null;
      return {
        type: 'weeklyOffer', weeklyOfferId: weeklyBundle.id, name: weeklyBundle.name,
        image: '/img/wochenangebot.png', pricePerItem: weeklyBundle.price, quantity: entry.quantity
      };
    }
    return entry;
  }).filter(Boolean).slice(0, MAX_ITEMS);
  persistCart();
}

function restoreWishlistFromStorage() {
  wishlistIds = wishlistIds.filter(id => products.some(product => product.id === id));
  persistWishlist();
  syncWishlistButtons();
  renderWishlist();
}

function createCartLine(item, index) {
  const row = document.createElement('div');
  row.className = 'cart-line';
  const thumb = document.createElement('div');
  thumb.className = 'cart-thumb';
  if (item.image) {
    const image = document.createElement('img');
    image.src = item.image;
    image.alt = '';
    image.loading = 'lazy';
    thumb.append(image);
  } else {
    const fallback = document.createElement('span');
    fallback.textContent = item.name.slice(0, 1).toUpperCase();
    thumb.append(fallback);
  }

  const copy = document.createElement('div');
  copy.className = 'cart-line-copy';
  const name = document.createElement('strong');
  name.className = 'cart-line-name';
  name.textContent = item.name;
  const meta = document.createElement('span');
  meta.className = 'cart-line-meta';
  meta.textContent = `Menge ${item.quantity} · ${formatPrice(item.pricePerItem)} / Stück`;
  copy.append(name, meta);

  const controls = document.createElement('div');
  controls.className = 'cart-line-controls';
  const lineTotal = document.createElement('strong');
  lineTotal.className = 'cart-line-total';
  lineTotal.textContent = formatPrice(item.quantity * item.pricePerItem);
  const actions = document.createElement('div');
  actions.className = 'cart-line-actions';
  const quantity = document.createElement('input');
  quantity.className = 'cart-quantity';
  quantity.type = 'number';
  quantity.min = '1';
  quantity.max = String(MAX_QUANTITY);
  quantity.step = '1';
  quantity.value = String(item.quantity);
  quantity.setAttribute('aria-label', `Menge für ${item.name}`);
  quantity.addEventListener('change', () => {
    const nextQuantity = Number(quantity.value);
    if (!isValidQuantity(nextQuantity)) {
      quantity.value = String(item.quantity);
      return;
    }
    cart[index].quantity = nextQuantity;
    persistCart();
    renderCart();
  });

  const remove = document.createElement('button');
  remove.className = 'remove-item';
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = `${item.name} entfernen`;
  remove.setAttribute('aria-label', `${item.name} aus dem Warenkorb entfernen`);
  remove.addEventListener('click', () => {
    cart.splice(index, 1);
    persistCart();
    renderCart();
    showCartFeedback(`${item.name} wurde aus dem Warenkorb entfernt.`, 'Warenkorb aktualisiert');
  });
  actions.append(quantity, remove);
  controls.append(lineTotal, actions);
  row.append(thumb, copy, controls);
  return row;
}

function renderCart() {
  cartContainer.replaceChildren();
  let total = 0;
  if (!cart.length) {
    const empty = document.createElement('div');
    empty.className = 'cart-empty';
    const title = document.createElement('strong');
    title.textContent = 'Dein Warenkorb ist noch leer.';
    const detail = document.createTextNode('Füge zuerst ein Produkt hinzu.');
    empty.append(title, detail);
    cartContainer.append(empty);
  } else {
    cart.forEach((item, index) => {
      total += item.quantity * item.pricePerItem;
      cartContainer.append(createCartLine(item, index));
    });
  }

  const itemLabel = `${cart.length} ${cart.length === 1 ? 'Position' : 'Positionen'}`;
  itemCount.textContent = itemLabel;
  cartCount.textContent = String(cart.length);
  cartCountLabel.setAttribute('aria-label', `Warenkorb, ${itemLabel}`);
  totalOutput.textContent = formatPrice(total);
  const hasContacts = Boolean(icNameInput.value.trim() && phoneInput.value.trim());
  submitButton.disabled = cart.length === 0 || !hasContacts;
  if (!cart.length) orderNote.textContent = 'Füge ein Produkt hinzu und ergänze deine Kontaktdaten.';
  else if (!hasContacts) orderNote.textContent = 'Noch nicht bereit — bitte Kontaktdaten ergänzen.';
  else orderNote.textContent = 'Bereit zum Absenden. Katalogpreise werden beim Bestellen geprüft.';
}

function setCustomStatus(message, type = '') {
  customStatus.textContent = message;
  customStatus.className = `status${type ? ` ${type}` : ''}`;
}

function addCustomItem() {
  const name = customNameInput.value.trim();
  const quantity = Number(customQuantityInput.value);
  const pricePerItem = Number(customPriceInput.value);
  if (!name || name.length > 80 || !isValidQuantity(quantity)
    || !Number.isSafeInteger(pricePerItem) || pricePerItem < 1 || pricePerItem > 1000000000) {
    setCustomStatus('Bitte Gegenstand, gültige Menge und Preisvorschlag eingeben.', 'error');
    return;
  }
  if (addToCart({ type: 'custom', name, quantity, pricePerItem })) {
    customNameInput.value = '';
    customQuantityInput.value = '1';
    customPriceInput.value = '';
    setCustomStatus(`${name} wurde als freie Position zum Warenkorb hinzugefügt.`, 'success');
  }
}

function renderAds(ads) {
  adList.replaceChildren();
  const validAds = Array.isArray(ads) ? ads.filter(ad => ad.title && (ad.href || ad.image)) : [];
  if (adRotationTimer) {
    clearInterval(adRotationTimer);
    adRotationTimer = null;
  }
  if (!validAds.length) {
    const placeholder = document.createElement('p');
    placeholder.className = 'shop-ad-placeholder';
    placeholder.textContent = 'Werbung und Hinweise erscheinen hier.';
    adList.append(placeholder);
    return;
  }

  let activeIndex = 0;
  const slides = [];
  const dots = [];
  const pagination = document.createElement('div');
  pagination.className = 'shop-ad-pagination';
  pagination.setAttribute('aria-label', 'Werbeanzeigen auswählen');

  function showAd(index) {
    activeIndex = (index + validAds.length) % validAds.length;
    slides.forEach((slide, slideIndex) => {
      slide.hidden = slideIndex !== activeIndex;
      if (dots[slideIndex]) dots[slideIndex].setAttribute('aria-current', String(slideIndex === activeIndex));
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
      image.loading = 'lazy';
      slide.append(image);
    }
    const copy = document.createElement('span');
    copy.className = 'ad-copy';
    const label = document.createElement('small');
    label.textContent = 'Werbung';
    const title = document.createElement('strong');
    title.textContent = ad.title;
    copy.append(label, title);
    if (ad.text) {
      const text = document.createElement('span');
      text.textContent = ad.text;
      copy.append(text);
    }
    if (ad.linkLabel) {
      const link = document.createElement('em');
      link.textContent = ad.linkLabel;
      copy.append(link);
    }
    slide.append(copy);
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

function loadProducts() {
  productsContainer.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'no-products';
  loading.textContent = 'Produkte werden geladen …';
  productsContainer.append(loading);
  catalogStatus.textContent = 'Produkte werden geladen …';
  resultCount.textContent = 'Katalog wird geladen …';
  weeklyBundleAddButton.disabled = true;

  return fetch('/api/shop/products')
    .then(async response => {
      const result = await response.json();
      if (!response.ok || result.ok !== true || !Array.isArray(result.products)) {
        throw new Error(result.message || 'Produktkatalog konnte nicht geladen werden.');
      }
      products = result.products;
      weeklyBundle = result.weeklyBundle || null;
      catalogStatus.textContent = `${products.length} ${products.length === 1 ? 'Produkt' : 'Produkte'} verfügbar`;
      renderCategoryFilters();
      renderWeeklyBundle();
      renderAds(Array.isArray(result.ads) ? result.ads : []);
      restoreCartFromStorage();
      restoreWishlistFromStorage();
      renderProducts();
      renderCart();
    })
    .catch(error => {
      productsContainer.replaceChildren();
      const errorPanel = document.createElement('div');
      errorPanel.className = 'catalog-error';
      const message = document.createElement('span');
      message.textContent = error.message || 'Produktkatalog konnte nicht geladen werden.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Erneut versuchen';
      retry.addEventListener('click', loadProducts);
      errorPanel.append(message, retry);
      productsContainer.append(errorPanel);
      catalogStatus.textContent = 'Katalog nicht verfügbar';
      resultCount.textContent = 'Produkte konnten nicht geladen werden';
      weeklyBundleSection.hidden = true;
      weeklyBundleAddButton.disabled = true;
      renderAds([]);
    });
}

noResultsWishButton.addEventListener('click', () => {
  customNameInput.value = (noResultsPanel.dataset.query || shopSearchInput.value.trim()).slice(0, 80);
  document.getElementById('wish-item').scrollIntoView({ behavior: 'smooth', block: 'center' });
  customNameInput.focus({ preventScroll: true });
});

shopSearchInput.addEventListener('input', renderProducts);
sortSelect.addEventListener('change', renderProducts);
document.getElementById('add-custom-item').addEventListener('click', addCustomItem);
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity() || !cart.length) return;

  const items = cart.map(item => item.type === 'catalog'
    ? { type: 'catalog', productId: item.productId, quantity: item.quantity }
    : item.type === 'weeklyOffer'
      ? { type: 'weeklyOffer', weeklyOfferId: item.weeklyOfferId, quantity: item.quantity }
      : { type: 'custom', name: item.name, quantity: item.quantity, pricePerItem: item.pricePerItem });
  const icName = icNameInput.value.trim();
  const phone = phoneInput.value.trim();
  statusBox.textContent = 'Bestellung wird gesendet …';
  statusBox.className = 'status order-status';
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
    statusBox.className = 'status order-status success';
    cart = [];
    persistCart();
    form.reset();
    renderCart();
    showCartFeedback('Bestellung wurde gesendet.', 'Der Warenkorb wurde geleert.');
  } catch (error) {
    statusBox.textContent = error.message || 'Fehler beim Senden der Bestellung.';
    statusBox.className = 'status order-status error';
    renderCart();
  }
});

icNameInput.addEventListener('input', renderCart);
phoneInput.addEventListener('input', renderCart);

renderCart();
renderWishlist();
loadProducts();

const productsContainer = document.getElementById('products');
const productCount = document.getElementById('product-count');
const statusBox = document.getElementById('status');
const loadState = document.getElementById('load-state');
const loadError = document.getElementById('load-error');
const loadErrorMessage = document.getElementById('load-error-message');
const catalogContent = document.getElementById('catalog-content');
const retryButton = document.getElementById('retry-load');
const addButton = document.getElementById('add-product');
const saveButton = document.getElementById('save-products');

const MAX_PRODUCTS = 200;
const MAX_PRICE = 1000000000;
const MAX_IMAGE_FILE_BYTES = 15 * 1024 * 1024;
const MAX_CATALOG_REQUEST_BYTES = 256 * 1024;
const CATALOG_SAVE_RESERVE_BYTES = 1024;
const MAX_IMAGE_DATA_URL_BYTES = 180 * 1024;

let products = [];
let savedSnapshot = [];
let catalogLoaded = false;
let isLoading = false;
let isSaving = false;
let isProcessingImage = false;
let openImageEditorId = null;

function cloneProducts(items) {
  return JSON.parse(JSON.stringify(items));
}

function normalizedCatalog(items) {
  return items.map(product => ({
    id: String(product.id || ''),
    name: String(product.name || ''),
    price: product.price === '' ? '' : Number(product.price),
    image: String(product.image || '').trim(),
    category: String(product.category || '').trim() || 'Allgemein',
    available: Boolean(product.available),
    active: Boolean(product.active)
  }));
}

function hasUnsavedChanges() {
  if (!catalogLoaded) return false;
  return JSON.stringify(normalizedCatalog(products)) !== JSON.stringify(normalizedCatalog(savedSnapshot));
}

function setStatus(message, state = 'idle') {
  statusBox.textContent = message;
  statusBox.dataset.state = state;
}

function refreshActionState() {
  const busy = isLoading || isSaving || isProcessingImage;
  const canEdit = catalogLoaded && !busy;
  const dirty = hasUnsavedChanges();
  productCount.textContent = `${products.length} von ${MAX_PRODUCTS} Produkten`;
  const atProductLimit = products.length >= MAX_PRODUCTS;
  addButton.disabled = !canEdit;
  addButton.title = atProductLimit ? 'Der Katalog kann höchstens 200 Produkte enthalten.' : '';
  saveButton.disabled = !canEdit || !dirty;
  retryButton.disabled = busy;

  productsContainer.querySelectorAll('input, button').forEach(control => {
    control.disabled = busy;
  });
}

function setLocalChangeStatus(message = 'Ungespeicherte Änderungen. Noch nicht im Shop veröffentlicht.') {
  if (hasUnsavedChanges()) setStatus(message, 'dirty');
  else setStatus('Keine ungespeicherten Änderungen.', 'success');
  refreshActionState();
}

function isDataImage(value) {
  return /^data:image\//i.test(String(value || ''));
}

function isValidImage(value) {
  const image = String(value || '').trim();
  if (!image) return true;
  return /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/i.test(image)
    || /^https?:\/\/[^\s]+\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(image)
    || /^\/img\/[^\s]+\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(image)
    || /^\.\.?\/[^\s]+\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i.test(image);
}

function makeProductId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const values = new Uint8Array(16);
  globalThis.crypto.getRandomValues(values);
  values[6] = (values[6] & 0x0f) | 0x40;
  values[8] = (values[8] & 0x3f) | 0x80;
  const hex = Array.from(values, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function makeField(labelText, value, fieldName, index, type = 'text') {
  const wrapper = document.createElement('label');
  wrapper.className = `field ${fieldName}-field`;
  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.id = `product-${index}-${fieldName}`;
  input.dataset.field = fieldName;
  input.value = value ?? '';
  if (fieldName === 'name') {
    input.maxLength = 80;
    input.autocomplete = 'off';
    input.required = true;
  } else if (fieldName === 'price') {
    input.min = '1';
    input.max = String(MAX_PRICE);
    input.step = '1';
    input.inputMode = 'numeric';
    input.required = true;
  } else if (fieldName === 'category') {
    input.maxLength = 40;
    input.autocomplete = 'off';
  }
  input.addEventListener('input', () => {
    products[index][fieldName] = fieldName === 'price'
      ? (input.value === '' ? '' : Number(input.value))
      : input.value;
    clearFieldError(input);
    setLocalChangeStatus();
  });
  wrapper.append(label, input);
  return { wrapper, input };
}

function setPreview(container, source, altText = '') {
  container.replaceChildren();
  if (!source) {
    container.textContent = 'Kein Bild';
    return;
  }
  const image = document.createElement('img');
  image.alt = altText;
  image.loading = 'lazy';
  image.onerror = () => {
    container.replaceChildren();
    container.textContent = 'Vorschau nicht verfügbar';
    container.classList.add('image-preview-error');
  };
  image.onload = () => container.classList.remove('image-preview-error');
  image.src = source;
  container.append(image);
}

function updateImageViews(record, product) {
  const thumb = record.querySelector('.image-thumb');
  const editorPreview = record.querySelector('.editor-preview-frame');
  setPreview(thumb, product.image, '');
  setPreview(editorPreview, product.image, `${product.name || 'Produkt'} – Bildvorschau`);
  const uploadedNote = record.querySelector('.uploaded-image-note');
  const pathInput = record.querySelector('.image-path-input');
  if (uploadedNote) uploadedNote.hidden = !isDataImage(product.image);
  if (pathInput && pathInput !== document.activeElement) {
    pathInput.value = isDataImage(product.image) ? '' : (product.image || '');
  }
}

function makeImageEditor(product, index, record) {
  const editor = document.createElement('section');
  editor.className = 'image-editor';
  editor.id = `product-image-editor-${index}`;
  editor.setAttribute('aria-label', `Bildbearbeitung für ${product.name || 'neues Produkt'}`);
  editor.hidden = product.id !== openImageEditorId;

  const preview = document.createElement('div');
  preview.className = 'editor-preview';
  const previewFrame = document.createElement('div');
  previewFrame.className = 'editor-preview-frame';
  const previewCaption = document.createElement('span');
  previewCaption.textContent = 'Bildvorschau';
  preview.append(previewFrame, previewCaption);

  const fields = document.createElement('div');
  fields.className = 'image-editor-fields';
  const pathLabel = document.createElement('label');
  pathLabel.className = 'field image-path-field';
  const pathCaption = document.createElement('span');
  pathCaption.className = 'field-label';
  pathCaption.textContent = 'Bildpfad oder URL';
  const pathInput = document.createElement('input');
  pathInput.className = 'image-path-input';
  pathInput.type = 'text';
  pathInput.maxLength = 2048;
  pathInput.autocomplete = 'off';
  pathInput.dataset.field = 'image-path';
  pathInput.placeholder = isDataImage(product.image) ? 'Hochgeladenes Bild – Pfad eingeben, um es zu ersetzen' : '/img/produkt.png';
  pathInput.value = isDataImage(product.image) ? '' : (product.image || '');
  pathInput.setAttribute('aria-label', `Bildpfad oder URL für ${product.name || 'neues Produkt'}`);
  pathInput.addEventListener('input', () => {
    products[index].image = pathInput.value.trim();
    clearFieldError(pathInput);
    updateImageViews(record, products[index]);
    setLocalChangeStatus('Bildpfad geändert. Katalog noch nicht gespeichert.');
  });
  pathLabel.append(pathCaption, pathInput);

  const uploadedNote = document.createElement('span');
  uploadedNote.className = 'uploaded-image-note';
  uploadedNote.textContent = 'Hochgeladenes Bild';
  uploadedNote.hidden = !isDataImage(product.image);

  const imageNote = document.createElement('p');
  imageNote.className = 'image-note';
  imageNote.textContent = 'Bilddatei maximal 15 MB. Bildänderungen werden erst mit dem Katalog gespeichert.';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  fileInput.tabIndex = -1;

  const actionRow = document.createElement('div');
  actionRow.className = 'image-editor-actions';
  const uploadButton = document.createElement('button');
  uploadButton.type = 'button';
  uploadButton.className = 'action-button';
  uploadButton.textContent = 'Bild hochladen';
  uploadButton.setAttribute('aria-label', `Bilddatei für ${product.name || 'neues Produkt'} hochladen`);
  uploadButton.addEventListener('click', () => fileInput.click());
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'action-button quiet close-image-editor';
  closeButton.textContent = 'Bildbearbeitung schließen';
  closeButton.addEventListener('click', () => {
    editor.hidden = true;
    openImageEditorId = null;
    const trigger = record.querySelector('.image-toggle');
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.focus();
  });
  actionRow.append(uploadButton, closeButton, fileInput);

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    isProcessingImage = true;
    setStatus('Bild wird vorbereitet …', 'saving');
    refreshActionState();
    try {
      const dataUrl = await imageFileToDataUrl(file, index);
      products[index].image = dataUrl;
      updateImageViews(record, products[index]);
      setLocalChangeStatus('Bild aktualisiert. Noch nicht gespeichert.');
    } catch (error) {
      setStatus(error.message || 'Das Bild konnte nicht verarbeitet werden.', 'error');
    } finally {
      isProcessingImage = false;
      fileInput.value = '';
      refreshActionState();
    }
  });

  fields.append(pathLabel, uploadedNote, imageNote, actionRow);
  editor.append(preview, fields);
  return editor;
}

function makeSwitch(labelText, fieldName, product, index) {
  const label = document.createElement('label');
  label.className = 'switch-control';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(product[fieldName]);
  input.id = `product-${index}-${fieldName}`;
  input.dataset.field = fieldName;
  const text = document.createElement('span');
  text.textContent = labelText;
  input.addEventListener('change', () => {
    products[index][fieldName] = input.checked;
    setLocalChangeStatus();
  });
  label.append(input, text);
  return label;
}

function makeProductRecord(product, index) {
  const record = document.createElement('article');
  record.className = 'product-record';
  record.dataset.productId = product.id;

  const row = document.createElement('div');
  row.className = 'product-row';
  const identity = document.createElement('div');
  identity.className = 'product-identity';

  const imageToggle = document.createElement('button');
  imageToggle.type = 'button';
  imageToggle.className = 'image-toggle';
  imageToggle.id = `product-${index}-image-toggle`;
  imageToggle.setAttribute('aria-controls', `product-image-editor-${index}`);
  imageToggle.setAttribute('aria-expanded', String(product.id === openImageEditorId));
  imageToggle.setAttribute('aria-label', `Bild ändern für ${product.name || 'neues Produkt'}`);
  imageToggle.title = `Bild ändern für ${product.name || 'neues Produkt'}`;
  const thumb = document.createElement('span');
  thumb.className = 'image-thumb';
  const toggleLabel = document.createElement('span');
  toggleLabel.className = 'image-toggle-label';
  toggleLabel.textContent = 'Bild ändern';
  imageToggle.append(thumb, toggleLabel);
  imageToggle.addEventListener('click', () => {
    const opening = product.id !== openImageEditorId;
    productsContainer.querySelectorAll('.image-editor').forEach(item => { item.hidden = true; });
    productsContainer.querySelectorAll('.image-toggle').forEach(button => button.setAttribute('aria-expanded', 'false'));
    openImageEditorId = opening ? product.id : null;
    editor.hidden = !opening;
    imageToggle.setAttribute('aria-expanded', String(opening));
    if (opening) editor.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  const name = makeField('Produktname', product.name, 'name', index);
  identity.append(imageToggle, name.wrapper);
  const price = makeField('Festpreis ($)', product.price, 'price', index, 'number');
  const category = makeField('Kategorie', product.category || 'Allgemein', 'category', index);

  const controls = document.createElement('div');
  controls.className = 'product-controls';
  const available = makeSwitch('Verfügbar', 'available', product, index);
  const active = makeSwitch('Aktiv', 'active', product, index);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-product';
  remove.textContent = 'Entfernen';
  remove.setAttribute('aria-label', `${product.name || 'Produkt'} entfernen; Änderung wird beim Speichern übernommen`);
  remove.title = 'Wird beim nächsten Speichern aus dem Shop-Katalog entfernt';
  remove.addEventListener('click', () => {
    const removedName = products[index].name || 'Produkt';
    products.splice(index, 1);
    if (openImageEditorId === product.id) openImageEditorId = null;
    renderProducts();
    setLocalChangeStatus(`${removedName} entfernt. Beim Speichern wird die Änderung übernommen.`);
    const nextField = productsContainer.querySelector(`.product-record:nth-child(${Math.min(index + 1, products.length)}) .name-field input`)
      || addButton;
    nextField.focus();
  });
  controls.append(available, active, remove);
  row.append(identity, price.wrapper, category.wrapper, controls);

  const editor = makeImageEditor(product, index, record);
  record.append(row, editor);
  updateImageViews(record, product);
  return record;
}

function renderProducts() {
  productsContainer.replaceChildren();
  if (!products.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Im Shop-Katalog sind noch keine Produkte. Füge ein Produkt hinzu, um zu beginnen.';
    productsContainer.append(empty);
    refreshActionState();
    return;
  }
  const fragment = document.createDocumentFragment();
  products.forEach((product, index) => fragment.append(makeProductRecord(product, index)));
  productsContainer.append(fragment);
  refreshActionState();
}

function clearFieldError(input) {
  input.removeAttribute('aria-invalid');
  const errorId = input.getAttribute('aria-describedby');
  if (errorId) document.getElementById(errorId)?.remove();
  input.removeAttribute('aria-describedby');
}

function clearValidationErrors() {
  productsContainer.querySelectorAll('[aria-invalid="true"]').forEach(clearFieldError);
  productsContainer.querySelectorAll('.field-error').forEach(error => error.remove());
}

function setFieldError(input, message) {
  clearFieldError(input);
  const error = document.createElement('span');
  error.className = 'field-error';
  error.id = `${input.id}-error`;
  error.textContent = message;
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', error.id);
  input.closest('.field')?.append(error);
}

function validateCatalog() {
  clearValidationErrors();
  const seenIds = new Set();
  let firstInvalid = null;
  let errorCount = 0;
  const addError = (input, message) => {
    setFieldError(input, message);
    firstInvalid ||= input;
    errorCount += 1;
  };

  products.forEach((product, index) => {
    const record = productsContainer.querySelectorAll('.product-record')[index];
    const name = String(product.name || '').trim();
    const price = Number(product.price);
    const category = String(product.category || '').trim() || 'Allgemein';
    const nameInput = record.querySelector('[data-field="name"]');
    const priceInput = record.querySelector('[data-field="price"]');
    const categoryInput = record.querySelector('[data-field="category"]');
    let imageInput = record.querySelector('.image-path-input');

    if (!/^[a-f0-9-]{36}$/i.test(product.id) || seenIds.has(product.id)) {
      addError(nameInput, 'Produkt-ID fehlt oder ist doppelt vorhanden.');
    }
    seenIds.add(product.id);
    if (!name) addError(nameInput, 'Produktname ist erforderlich.');
    else if (name.length > 80) addError(nameInput, 'Produktname darf höchstens 80 Zeichen enthalten.');
    if (!Number.isSafeInteger(price) || price < 1 || price > MAX_PRICE) {
      addError(priceInput, 'Preis muss eine ganze Zahl zwischen 1 und 1.000.000.000 sein.');
    }
    if (category.length > 40) addError(categoryInput, 'Kategorie darf höchstens 40 Zeichen enthalten.');
    if (!isValidImage(product.image)) {
      const editor = record.querySelector('.image-editor');
      if (editor.hidden) {
        editor.hidden = false;
        openImageEditorId = product.id;
        record.querySelector('.image-toggle').setAttribute('aria-expanded', 'true');
        imageInput = record.querySelector('.image-path-input');
      }
      addError(imageInput, 'Bitte einen gültigen Bildpfad, eine URL oder ein Bild verwenden.');
    }
    if (imageInput && !record.querySelector('.image-editor').hidden && isDataImage(product.image)) {
      imageInput.value = '';
    }
  });

  if (errorCount && firstInvalid) {
    if (firstInvalid.dataset.field === 'image-path') {
      const record = firstInvalid.closest('.product-record');
      const toggle = record.querySelector('.image-toggle');
      record.querySelector('.image-editor').hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
    }
    firstInvalid.focus();
    firstInvalid.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setStatus('Bitte prüfe die markierten Produktfelder.', 'error');
    return false;
  }
  return true;
}

function productsForRequest(source = products) {
  return source.map(product => ({
    id: String(product.id || ''),
    name: String(product.name || '').trim(),
    price: Number(product.price),
    image: String(product.image || '').trim(),
    category: String(product.category || '').trim() || 'Allgemein',
    available: Boolean(product.available),
    active: Boolean(product.active)
  }));
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

function imageBudgetForProduct(index) {
  const withoutCurrentImage = productsForRequest();
  if (withoutCurrentImage[index]) withoutCurrentImage[index].image = '';
  const baseBytes = byteLength(JSON.stringify({ products: withoutCurrentImage }));
  return MAX_CATALOG_REQUEST_BYTES - baseBytes - CATALOG_SAVE_RESERVE_BYTES;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Das Bild konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Das Bild konnte nicht verarbeitet werden.'));
    image.src = source;
  });
}

async function imageFileToDataUrl(file, productIndex) {
  if (!file || !file.type.startsWith('image/')) throw new Error('Bitte wähle eine gültige Bilddatei aus.');
  if (file.size > MAX_IMAGE_FILE_BYTES) throw new Error('Das Bild ist zu groß. Bitte wähle eine Datei bis maximal 15 MB.');

  const budget = Math.min(MAX_IMAGE_DATA_URL_BYTES, imageBudgetForProduct(productIndex));
  if (budget <= 0) throw new Error('Für dieses Bild ist im Katalog nicht genügend Speicherplatz. Bitte verkleinere andere Uploads oder nutze einen Bildpfad.');

  const source = await readFileAsDataUrl(file);
  const supportedDataImage = /^image\/(png|jpe?g|webp|gif|svg\+xml)$/i.test(file.type);
  if (source.length <= budget && supportedDataImage) return source;

  const image = await loadImage(source);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Die Bildbearbeitung ist in diesem Browser nicht verfügbar.');
  context.fillStyle = '#fff';

  const sizes = [1600, 1400, 1200, 1000, 840, 720, 600, 480, 360, 280];
  const qualities = [.84, .76, .68, .6, .52, .44, .36];
  for (const maxSide of sizes) {
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of qualities) {
      const candidate = canvas.toDataURL('image/jpeg', quality);
      if (candidate.length <= budget) return candidate;
    }
  }
  throw new Error('Das Bild lässt sich nicht klein genug für den Katalog speichern. Bitte wähle ein kleineres Bild oder nutze einen Bildpfad.');
}

async function loadProducts() {
  isLoading = true;
  catalogLoaded = false;
  loadState.hidden = false;
  loadState.textContent = 'Produkte werden geladen …';
  loadError.hidden = true;
  catalogContent.hidden = true;
  setStatus('Produkte werden geladen …', 'loading');
  refreshActionState();
  try {
    const response = await fetch('/api/admin/shop-products');
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || !Array.isArray(result.products)) {
      throw new Error(result.message || 'Produkte konnten nicht geladen werden.');
    }
    products = cloneProducts(result.products);
    savedSnapshot = cloneProducts(result.products);
    catalogLoaded = true;
    openImageEditorId = null;
    loadState.hidden = true;
    loadError.hidden = true;
    catalogContent.hidden = false;
    renderProducts();
    setStatus('Katalog geladen. Noch keine Änderungen gespeichert.', 'idle');
  } catch (error) {
    products = [];
    catalogLoaded = false;
    loadState.hidden = true;
    catalogContent.hidden = true;
    loadError.hidden = false;
    loadErrorMessage.textContent = error.message || 'Bitte prüfe die Verbindung und versuche es erneut.';
    setStatus('Katalog konnte nicht geladen werden. Speichern ist deaktiviert.', 'error');
  } finally {
    isLoading = false;
    refreshActionState();
  }
}

function addProduct() {
  if (!catalogLoaded || isSaving || isProcessingImage) return;
  if (products.length >= MAX_PRODUCTS) {
    setStatus('Der Katalog kann höchstens 200 Produkte enthalten.', 'warning');
    return;
  }
  const product = { id: makeProductId(), name: '', price: '', image: '', category: 'Allgemein', available: true, active: true };
  products.push(product);
  renderProducts();
  setLocalChangeStatus('Produkt hinzugefügt. Angaben vervollständigen und Katalog speichern.');
  const index = products.length - 1;
  const record = productsContainer.querySelectorAll('.product-record')[index];
  record.scrollIntoView({ block: 'center', behavior: 'smooth' });
  record.querySelector('.name-field input').focus({ preventScroll: true });
}

async function saveProducts() {
  if (!catalogLoaded || isSaving || isProcessingImage || !hasUnsavedChanges()) return;
  clearValidationErrors();
  if (!validateCatalog()) return;
  const normalized = productsForRequest();
  const requestBody = JSON.stringify({ products: normalized });
  if (byteLength(requestBody) > MAX_CATALOG_REQUEST_BYTES) {
    setStatus('Katalog ist zu groß für eine sichere Übertragung. Bitte verkleinere Bilddateien oder nutze Bildpfade.', 'error');
    return;
  }

  isSaving = true;
  setStatus('Katalog wird gespeichert …', 'saving');
  refreshActionState();
  try {
    const response = await fetch('/api/admin/shop-products', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || !Array.isArray(result.products)) {
      throw new Error(result.message || 'Der Server konnte den Katalog nicht speichern.');
    }
    products = cloneProducts(result.products);
    savedSnapshot = cloneProducts(result.products);
    renderProducts();
    if (result.auditLogged === false) {
      setStatus(`Katalog gespeichert. Discord-Audit konnte nicht gesendet werden. ${result.warning || ''}`.trim(), 'warning');
    } else if (result.auditChangeCount === 0) {
      setStatus('Katalog gespeichert. Keine Änderungen zu protokollieren.', 'success');
    } else {
      setStatus('Katalog gespeichert. Änderungen im Discord-Audit protokolliert.', 'success');
    }
  } catch (error) {
    setStatus(`Speichern fehlgeschlagen. Deine Änderungen bleiben erhalten. ${error.message || ''}`.trim(), 'error');
  } finally {
    isSaving = false;
    refreshActionState();
  }
}

addButton.addEventListener('click', addProduct);
saveButton.addEventListener('click', saveProducts);
retryButton.addEventListener('click', loadProducts);
window.addEventListener('beforeunload', event => {
  if (!hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = '';
});

loadProducts();

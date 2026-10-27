"use strict";

const form = document.getElementById("sell-offer-form");
const statusBox = document.getElementById("status");
const submitButton = form.querySelector('button[type="submit"]');
const productsContainer = document.getElementById("buyback-products");
const selectedItemsSummary = document.getElementById("selected-items");
const estimatedTotal = document.getElementById("estimated-total");
const numberFormatter = new Intl.NumberFormat("de-DE");
let products = [];

function formatPrice(value) {
  return `${numberFormatter.format(value)} $`;
}

function updateSummary() {
  const selectedItems = [];
  const invalidItems = [];
  for (const item of productsContainer.querySelectorAll(".price-item")) {
    if (!item.querySelector(".product-select").checked) continue;
    const product = products.find(entry => entry.id === item.dataset.productId);
    const quantity = Number(item.querySelector(".quantity-input").value);
    if (!product || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) {
      invalidItems.push(product?.name || "Gegenstand");
      continue;
    }
    selectedItems.push({ product, quantity, total: product.price * quantity });
  }
  const total = selectedItems.reduce((sum, item) => sum + item.total, 0);

  const summaryLines = selectedItems.map(({ product, quantity }) => `${product.name}: ${numberFormatter.format(quantity)} Stück`);
  if (invalidItems.length) summaryLines.push(`Stückzahl prüfen: ${invalidItems.join(", ")}`);
  selectedItemsSummary.textContent = summaryLines.length ? summaryLines.join(" · ") : "Noch keine Gegenstände ausgewählt.";
  estimatedTotal.textContent = formatPrice(total);
  return { selectedItems, invalidItems };
}

function renderProducts() {
  const fragment = document.createDocumentFragment();
  for (const product of products) {
    const item = document.createElement("div");
    item.className = "price-item";
    item.dataset.productId = product.id;

    const main = document.createElement("div");
    main.className = "item-main";

    const checkbox = document.createElement("input");
    checkbox.className = "product-select";
    checkbox.type = "checkbox";
    checkbox.id = `buyback-${product.id}`;
    checkbox.setAttribute("aria-label", `${product.name} auswählen`);

    const name = document.createElement("label");
    name.className = "item-name";
    name.htmlFor = checkbox.id;
    name.textContent = product.name;

    const price = document.createElement("strong");
    price.className = "item-price";
    price.textContent = formatPrice(product.price);

    main.append(checkbox, name, price);

    const quantityControl = document.createElement("div");
    quantityControl.className = "quantity-control";

    const decreaseButton = document.createElement("button");
    decreaseButton.type = "button";
    decreaseButton.className = "quantity-step";
    decreaseButton.dataset.step = "-1";
    decreaseButton.textContent = "−";
    decreaseButton.setAttribute("aria-label", `${product.name} Stückzahl verringern`);

    const quantityInput = document.createElement("input");
    quantityInput.className = "quantity-input";
    quantityInput.id = `quantity-${product.id}`;
    quantityInput.type = "number";
    quantityInput.min = "1";
    quantityInput.max = "10000";
    quantityInput.step = "1";
    quantityInput.value = "1";
    quantityInput.disabled = true;
    quantityInput.setAttribute("aria-label", `Stückzahl ${product.name}`);

    const increaseButton = document.createElement("button");
    increaseButton.type = "button";
    increaseButton.className = "quantity-step";
    increaseButton.dataset.step = "1";
    increaseButton.textContent = "+";
    increaseButton.setAttribute("aria-label", `${product.name} Stückzahl erhöhen`);

    quantityControl.append(decreaseButton, quantityInput, increaseButton);
    item.append(main, quantityControl);
    fragment.append(item);
  }
  productsContainer.replaceChildren(fragment);
  updateSummary();
}

productsContainer.addEventListener("change", event => {
  const item = event.target.closest(".price-item");
  if (!item) return;

  if (event.target.matches(".product-select")) {
    item.querySelector(".quantity-input").disabled = !event.target.checked;
    item.classList.toggle("selected", event.target.checked);
  }
  updateSummary();
});

productsContainer.addEventListener("click", event => {
  const button = event.target.closest(".quantity-step");
  if (button) {
    const item = button.closest(".price-item");
    const quantityInput = item.querySelector(".quantity-input");
    const step = Number(button.dataset.step);
    const current = Number(quantityInput.value);
    quantityInput.value = String(Math.max(1, Math.min(10000, (Number.isSafeInteger(current) ? current : 1) + step)));
    updateSummary();
    return;
  }

  const item = event.target.closest(".price-item");
  if (!item || event.target.closest("input, label")) return;
  const checkbox = item.querySelector(".product-select");
  if (!checkbox.checked) {
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  }
});

productsContainer.addEventListener("input", event => {
  if (event.target.matches(".quantity-input")) updateSummary();
});

async function loadProducts() {
  try {
    const response = await fetch("/api/ankauf-produkte");
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false || !Array.isArray(result.products)) {
      throw new Error(result.message || "Ankaufartikel konnten nicht geladen werden.");
    }
    products = result.products;
    renderProducts();
    submitButton.disabled = false;
  } catch (error) {
    productsContainer.replaceChildren();
    const message = document.createElement("p");
    message.className = "loading-products";
    message.textContent = error.message || "Ankaufartikel konnten nicht geladen werden.";
    productsContainer.append(message);
    statusBox.textContent = message.textContent;
    statusBox.className = "status error";
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();

  const { selectedItems, invalidItems } = updateSummary();
  if (invalidItems.length) {
    statusBox.textContent = "Bitte trage für jeden ausgewählten Gegenstand eine Stückzahl zwischen 1 und 10.000 ein.";
    statusBox.className = "status error";
    return;
  }
  if (!selectedItems.length) {
    statusBox.textContent = "Bitte wähle mindestens einen Gegenstand aus und gib eine Stückzahl an.";
    statusBox.className = "status error";
    return;
  }

  const payload = {
    items: selectedItems.map(({ product, quantity }) => ({ productId: product.id, quantity })),
    icName: document.getElementById("ic-name").value.trim(),
    phone: document.getElementById("phone").value.trim()
  };

  statusBox.textContent = "Angebot wird gespeichert...";
  statusBox.className = "status";
  submitButton.disabled = true;

  try {
    const response = await fetch("/api/ankauf-angebot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok || result.ok === false) {
      throw new Error(result.message || "Angebot konnte nicht gespeichert werden.");
    }

    statusBox.textContent = result.message || "Dein Angebot wurde gespeichert.";
    statusBox.className = "status success";
    form.reset();
    productsContainer.querySelectorAll(".price-item").forEach(item => {
      item.querySelector(".product-select").checked = false;
      item.classList.remove("selected");
      item.querySelector(".quantity-input").disabled = true;
      item.querySelector(".quantity-input").value = "1";
    });
    updateSummary();
  } catch (error) {
    statusBox.textContent = error.message || "Fehler beim Speichern des Angebots.";
    statusBox.className = "status error";
  } finally {
    submitButton.disabled = false;
  }
});

void loadProducts();

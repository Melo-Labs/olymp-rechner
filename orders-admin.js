const ordersContainer = document.getElementById('orders');
const statusMessage = document.getElementById('status-message');
const statusFilter = document.getElementById('status-filter');
const statuses = [
  { value: 'new', label: 'Neu' },
  { value: 'accepted', label: 'Angenommen' },
  { value: 'processing', label: 'In Bearbeitung' },
  { value: 'completed', label: 'Erledigt' },
  { value: 'rejected', label: 'Abgelehnt' }
];
const typeLabels = {
  material: 'Materialbestellung',
  stank: 'STANK-Bestellung',
  custom: 'Wunsch-Bestellung',
  'sell-offer': 'Ankauf-Angebot'
};
let orders = [];

function showStatus(message, state = '') {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${state}`.trim();
}

function orderDetails(order) {
  if (order.type === 'material') {
    return `Technische Materialien: ${order.technical}\nMedizinische Materialien: ${order.medical}\nGesamtanzahl: ${order.totalMaterials}`;
  }
  if (order.type === 'stank') return `STANK-Pflanzen: ${order.quantity}`;
  if ((order.type === 'custom' || order.type === 'sell-offer') && Array.isArray(order.items)) {
    return order.items.map(item =>
      `${item.quantity} × ${item.name} — ${Number(item.totalPrice).toLocaleString('de-DE')} $`
    ).join('\n');
  }
  return 'Keine weiteren Positionsdaten vorhanden.';
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Zeit unbekannt' : date.toLocaleString('de-DE');
}

function renderOrders() {
  const visibleOrders = orders.filter(order => !statusFilter.value || order.status === statusFilter.value);
  ordersContainer.replaceChildren();
  if (!visibleOrders.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = orders.length ? 'Für diesen Status gibt es keine Bestellungen.' : 'Noch keine Bestellungen vorhanden.';
    ordersContainer.append(empty);
    return;
  }

  for (const order of visibleOrders) {
    const card = document.createElement('article');
    card.className = 'order';
    const head = document.createElement('div');
    head.className = 'order-head';
    const title = document.createElement('div');
    const heading = document.createElement('h2');
    heading.textContent = `${typeLabels[order.type] || 'Bestellung'} · ${order.icName || order.customerName || 'Unbekannt'}`;
    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = `${dateLabel(order.createdAt)} · ${order.phone || 'Keine Telefonnummer'}`;
    title.append(heading, meta);
    const badge = document.createElement('span');
    badge.className = 'status';
    badge.textContent = order.status || 'Neu';
    head.append(title, badge);

    const details = document.createElement('p');
    details.className = 'details';
    details.textContent = `${orderDetails(order)}\nGesamt: ${Number(order.totalPrice || 0).toLocaleString('de-DE')} $`;
    const delivery = document.createElement('p');
    delivery.className = 'delivery';
    delivery.textContent = order.deliveryStatus === 'bot'
      ? 'Discord-Nachricht: gesendet'
      : order.deliveryStatus === 'local-only'
        ? 'Discord-Nachricht: noch nicht gesendet (lokal gespeichert)'
        : order.deliveryStatus === 'failed'
          ? `Discord-Nachricht: fehlgeschlagen${order.deliveryError ? ` · ${order.deliveryError}` : ''}`
          : 'Discord-Nachricht: wird verarbeitet';

    const actions = document.createElement('div');
    actions.className = 'actions';
    for (const status of statuses) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = status.label;
      button.disabled = order.status === status.label;
      if (button.disabled) button.classList.add('active');
      button.addEventListener('click', () => updateStatus(order, status.value, button));
      actions.append(button);
    }
    card.append(head, details, delivery, actions);
    ordersContainer.append(card);
  }
}

async function loadOrders() {
  ordersContainer.textContent = 'Bestellungen werden geladen …';
  try {
    const response = await fetch('/api/admin/orders');
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || !Array.isArray(result.orders)) {
      throw new Error(result.message || 'Bestellungen konnten nicht geladen werden.');
    }
    orders = result.orders;
    renderOrders();
    showStatus(`${orders.length} Bestellung(en) geladen.`, 'success');
  } catch (error) {
    ordersContainer.textContent = '';
    showStatus(error.message || 'Bestellungen konnten nicht geladen werden.', 'error');
  }
}

async function updateStatus(order, status, button) {
  button.disabled = true;
  try {
    const response = await fetch(`/api/admin/orders/${encodeURIComponent(order.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || !result.order) {
      throw new Error(result.message || 'Status konnte nicht gespeichert werden.');
    }
    orders = orders.map(item => item.id === result.order.id ? result.order : item);
    renderOrders();
    showStatus(result.warning || 'Bestellstatus wurde gespeichert.', result.warning ? 'error' : 'success');
  } catch (error) {
    button.disabled = false;
    showStatus(error.message || 'Status konnte nicht gespeichert werden.', 'error');
  }
}

statusFilter.addEventListener('change', renderOrders);
document.getElementById('refresh-orders').addEventListener('click', loadOrders);
loadOrders();

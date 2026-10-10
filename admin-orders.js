const orderBody = document.getElementById('orders-body');
const orderCount = document.getElementById('order-count');
const statusMessage = document.getElementById('status-message');

const STATUS_OPTIONS = [
  'Neu',
  'In Bearbeitung',
  'Bestätigt',
  'In Produktion',
  'Versendet',
  'Abgeschlossen',
  'Abgelehnt'
];

function badgeClass(status) {
  const key = String(status || 'Neu').trim().toLowerCase();
  if (key.includes('bearbeitung')) return 'bearbeitung';
  if (key.includes('bestätigt') || key.includes('bestaetigt')) return 'bestaetigt';
  if (key.includes('produktion')) return 'produktion';
  if (key.includes('versendet')) return 'versendet';
  if (key.includes('abgeschlossen')) return 'abgeschlossen';
  if (key.includes('abgelehnt')) return 'abgelehnt';
  return 'neu';
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatOrderLine(order) {
  if (!Array.isArray(order.items) || !order.items.length) {
    if (order.source === 'material') {
      return `Technik ${order.raw?.technical ?? 0} / Medizin ${order.raw?.medical ?? 0}`;
    }
    if (order.source === 'stank') {
      return `${order.raw?.quantity ?? 0} STANK`; 
    }
    return '—';
  }
  return order.items.slice(0, 2).map(item => `${item.name || 'Position'} (${item.quantity || 0})`).join(', ') + (order.items.length > 2 ? ' …' : '');
}

function renderOrders(orders) {
  orderBody.innerHTML = '';
  orderCount.textContent = `${orders.length} Bestellungen`;

  if (!orders.length) {
    orderBody.innerHTML = '<tr><td colspan="7" class="empty">Noch keine Bestellungen eingegangen.</td></tr>';
    return;
  }

  orders.forEach(order => {
    const row = document.createElement('tr');
    const total = Number(order.total || 0);
    const status = String(order.status || 'Neu');
    const badge = document.createElement('span');
    badge.className = `badge ${badgeClass(status)}`;
    badge.textContent = status;

    const select = document.createElement('select');
    select.className = 'status-select';
    STATUS_OPTIONS.forEach(optionValue => {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionValue;
      if (optionValue === status) option.selected = true;
      select.append(option);
    });
    select.addEventListener('change', async () => {
      try {
        const response = await fetch('/api/admin/orders', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: order.id, status: select.value })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.ok !== true) {
          throw new Error(result.message || 'Status konnte nicht aktualisiert werden.');
        }
        statusMessage.textContent = `Status für ${order.id} wurde auf ${select.value} gesetzt.`;
        loadOrders();
      } catch (error) {
        statusMessage.textContent = error.message || 'Status konnte nicht aktualisiert werden.';
      }
    });

    row.innerHTML = `
      <td><strong>${order.id || '—'}</strong></td>
      <td>
        <div>${order.customerName || 'Unbekannt'}</div>
        <div class="muted">${order.phone || 'Keine Telefonnummer'}</div>
      </td>
      <td>${order.source || 'custom'}</td>
      <td>${formatOrderLine(order)}</td>
      <td>${total.toLocaleString('de-DE')} $</td>
      <td></td>
      <td>${formatDate(order.updatedAt || order.createdAt)}</td>
    `;

    const statusCell = row.children[5];
    statusCell.append(badge, document.createElement('br'));
    statusCell.append(select);
    orderBody.append(row);
  });
}

async function loadOrders() {
  statusMessage.textContent = 'Bestellungen werden geladen…';
  try {
    const response = await fetch('/api/admin/orders');
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || !Array.isArray(result.orders)) {
      throw new Error(result.message || 'Bestellungen konnten nicht geladen werden.');
    }
    renderOrders(result.orders);
    statusMessage.textContent = 'Bestellungen geladen.';
  } catch (error) {
    orderBody.innerHTML = '<tr><td colspan="7" class="empty">Bestellungen konnten nicht geladen werden.</td></tr>';
    statusMessage.textContent = error.message || 'Bestellungen konnten nicht geladen werden.';
  }
}

loadOrders();

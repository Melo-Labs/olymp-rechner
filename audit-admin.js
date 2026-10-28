const form = document.getElementById('audit-form');
const queryInput = document.getElementById('audit-query');
const categorySelect = document.getElementById('audit-category');
const limitSelect = document.getElementById('audit-limit');
const reloadButton = document.getElementById('audit-reload');
const statusLine = document.getElementById('audit-status');
const rows = document.getElementById('audit-rows');
const categoryLabels = {
  familie: 'Familien',
  ticket: 'Tickets',
  coupon: 'Coupons',
  familienkasse: 'Familienkassen',
  buchung: 'Buchungen'
};
let loading = false;

function showStatus(message, state = '') {
  statusLine.textContent = message;
  statusLine.className = `status ${state}`.trim();
}

function cell(text, className = '') {
  const element = document.createElement('td');
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function timeLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '–' : date.toLocaleString('de-DE');
}

function renderEntries(entries) {
  rows.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement('tr');
    const category = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = categoryLabels[entry.category] || entry.category;
    category.append(badge);
    row.append(
      cell(timeLabel(entry.timestamp), 'time'),
      category,
      cell(entry.action),
      cell(entry.subject || '–'),
      cell(entry.actorName || entry.actorId || '–'),
      cell(entry.details || '', 'details')
    );
    rows.append(row);
  }
}

async function loadAudit() {
  if (loading) return;
  loading = true;
  reloadButton.disabled = true;
  showStatus('Audit wird geladen …');
  try {
    const params = new URLSearchParams({ limit: limitSelect.value });
    if (categorySelect.value) params.set('category', categorySelect.value);
    if (queryInput.value.trim()) params.set('q', queryInput.value.trim());
    const response = await fetch(`/api/admin/audit?${params}`);
    const result = await response.json();
    if (!response.ok || result.ok !== true || !Array.isArray(result.entries)) {
      throw new Error(result.message || 'Das Audit konnte nicht geladen werden.');
    }
    renderEntries(result.entries);
    showStatus(result.entries.length ? `${result.entries.length} Eintrag/Einträge angezeigt.` : 'Keine passenden Einträge gefunden.');
  } catch (error) {
    rows.replaceChildren();
    showStatus(error.message || 'Das Audit konnte nicht geladen werden.', 'error');
  } finally {
    loading = false;
    reloadButton.disabled = false;
  }
}

form.addEventListener('submit', event => {
  event.preventDefault();
  void loadAudit();
});

void loadAudit();

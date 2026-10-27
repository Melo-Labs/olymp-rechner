const entriesElement = document.getElementById('entries');
const statusMessage = document.getElementById('status-message');
const periodFilter = document.getElementById('period-filter');
const totalIncome = document.getElementById('total-income');
const totalExpense = document.getElementById('total-expense');
const netBalance = document.getElementById('net-balance');
const entryLimit = document.getElementById('entry-limit');
const categoryLabels = {
  material: 'Materialbestellung',
  stank: 'STANK-Bestellung',
  custom: 'Wunschbestellung',
  'sell-offer': 'Ankauf-Ausgabe',
  manual: 'Manuelle Buchung'
};
let loading = false;

function money(value) {
  return `${Number(value || 0).toLocaleString('de-DE')} $`;
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Zeit unbekannt' : date.toLocaleString('de-DE');
}

function showStatus(message, kind = '') {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${kind}`.trim();
}

function renderEntries(entries) {
  entriesElement.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Für diesen Zeitraum gibt es noch keine Buchungen.';
    entriesElement.append(empty);
    return;
  }

  for (const entry of entries) {
    const article = document.createElement('article');
    article.className = 'entry';
    const head = document.createElement('div');
    head.className = 'entry-head';
    const title = document.createElement('h2');
    title.textContent = `${categoryLabels[entry.category] || entry.category} · ${entry.description}`;
    const amount = document.createElement('span');
    amount.className = `amount ${entry.kind === 'income' ? 'income' : 'expense'}`;
    amount.textContent = `${entry.kind === 'income' ? '+' : '−'}${money(entry.amount)}`;
    head.append(title, amount);
    const meta = document.createElement('p');
    meta.textContent = `${dateLabel(entry.bookedAt)} · ${entry.bookedBy || 'System'}${entry.source === 'order' ? ' · Bestellung' : ' · manuell'}`;
    article.append(head, meta);
    if (entry.voided) {
      const voidNote = document.createElement('p');
      voidNote.textContent = `Storniert am ${dateLabel(entry.voided.at)} von ${entry.voided.by || 'System'}${entry.voided.reason ? ` · ${entry.voided.reason}` : ''}`;
      article.append(voidNote);
    }
    entriesElement.append(article);
  }
}

async function loadLedger() {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch(`/api/admin/accounting?period=${encodeURIComponent(periodFilter.value)}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true || !Array.isArray(result.entries) || !result.summary) {
      throw new Error(result.message || 'Die Buchhaltung konnte nicht geladen werden.');
    }
    totalIncome.textContent = money(result.summary.income);
    totalExpense.textContent = money(result.summary.expense);
    netBalance.textContent = money(result.summary.net);
    netBalance.className = result.summary.net < 0 ? 'expense' : 'income';
    renderEntries(result.entries);
    entryLimit.textContent = result.totalEntries > result.entries.length
      ? `Es werden die neuesten ${result.entries.length} von ${result.totalEntries} Buchungen angezeigt. Die Summen enthalten alle Buchungen des Zeitraums.`
      : `${result.totalEntries} Buchung(en) · ${result.period}`;
    showStatus('Buchhaltung ist synchronisiert.', 'success');
  } catch (error) {
    showStatus(error.message || 'Die Buchhaltung konnte nicht geladen werden.', 'error');
  } finally {
    loading = false;
  }
}

periodFilter.addEventListener('change', loadLedger);
document.getElementById('refresh-ledger').addEventListener('click', loadLedger);
loadLedger();
window.setInterval(loadLedger, 30_000);

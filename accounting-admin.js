const entriesElement = document.getElementById('entries');
const statusMessage = document.getElementById('status-message');
const periodFilter = document.getElementById('period-filter');
const totalIncome = document.getElementById('total-income');
const totalExpense = document.getElementById('total-expense');
const netBalance = document.getElementById('net-balance');
const entryLimit = document.getElementById('entry-limit');
const manualEntryForm = document.getElementById('manual-entry-form');
const manualEntryFeedback = document.getElementById('manual-entry-feedback');
const categoryLabels = {
  material: 'Materialbestellung',
  stank: 'STANK-Bestellung',
  custom: 'Wunschbestellung',
  'sell-offer': 'Ankauf-Ausgabe',
  manual: 'Manuelle Buchung'
};
let loading = false;
let reloadPending = false;
let manualSourceId = window.crypto.randomUUID();

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
    const idLine = document.createElement('p');
    idLine.className = 'entry-id';
    idLine.textContent = `Buchungs-ID: ${entry.id}`;
    article.append(idLine);
    if (entry.voided) {
      const voidNote = document.createElement('p');
      const actionLabel = entry.voided.action === 'corrected' ? 'Korrigiert' : 'Storniert';
      const replacementLabel = entry.voided.replacementId ? ` · Ersatzbuchung: ${entry.voided.replacementId}` : '';
      voidNote.textContent = `${actionLabel} am ${dateLabel(entry.voided.at)} von ${entry.voided.by || 'System'}${entry.voided.reason ? ` · ${entry.voided.reason}` : ''}${replacementLabel}`;
      article.append(voidNote);
    } else {
      article.append(createEntryActions(entry));
    }
    entriesElement.append(article);
  }
}

function addField(form, labelText, name, type, value, options = {}) {
  const field = document.createElement('div');
  field.className = 'field';
  const label = document.createElement('label');
  const id = `entry-${crypto.randomUUID()}`;
  label.htmlFor = id;
  label.textContent = labelText;
  let input;
  if (type === 'select') {
    input = document.createElement('select');
    for (const [optionValue, optionLabel] of options.choices) {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionLabel;
      input.append(option);
    }
  } else {
    input = document.createElement(type);
  }
  input.id = id;
  input.name = name;
  if (type === 'number') {
    input.min = '1';
    input.max = '1000000000';
    input.step = '1';
    input.inputMode = 'numeric';
  }
  if (type === 'textarea' || type === 'input') input.maxLength = 200;
  input.required = true;
  input.value = value;
  field.append(label, input);
  form.append(field);
  return input;
}

function createEntryActions(entry) {
  const actions = document.createElement('details');
  actions.className = 'entry-actions';
  const summary = document.createElement('summary');
  summary.textContent = entry.category === 'manual' ? 'Korrigieren oder stornieren' : 'Buchung korrigieren';
  actions.append(summary);

  const correctionForm = document.createElement('form');
  correctionForm.className = 'correction-form';
  correctionForm.setAttribute('aria-label', `Buchung ${entry.id} korrigieren`);
  const fields = document.createElement('div');
  fields.className = 'entry-action-grid';
  correctionForm.append(fields);
  const kind = addField(correctionForm, 'Neue Buchungsart', 'kind', 'select', entry.kind, {
    choices: [['income', 'Einnahme'], ['expense', 'Ausgabe']]
  });
  const amount = addField(correctionForm, 'Neuer Betrag in Dollar', 'amount', 'number', entry.amount);
  const description = addField(correctionForm, 'Neue Beschreibung', 'description', 'input', entry.description);
  const reason = addField(correctionForm, 'Grund der Korrektur', 'reason', 'textarea', '');
  const correctionFields = [kind.parentElement, amount.parentElement, description.parentElement, reason.parentElement];
  for (const field of correctionFields) fields.append(field);
  const correctionButton = document.createElement('button');
  correctionButton.className = 'primary-action';
  correctionButton.type = 'submit';
  correctionButton.textContent = 'Korrektur speichern';
  correctionForm.append(correctionButton);
  correctionForm.addEventListener('submit', event => {
    event.preventDefault();
    submitEntryChange(entry, correctionForm, {
      kind: kind.value,
      amount: Number(amount.value),
      description: description.value.trim()
    }, correctionButton);
  });
  actions.append(correctionForm);

  if (entry.category === 'manual') {
    const voidForm = document.createElement('form');
    voidForm.className = 'correction-form';
    voidForm.setAttribute('aria-label', `Buchung ${entry.id} stornieren`);
    addField(voidForm, 'Grund des Stornos', 'reason', 'textarea', '');
    const voidButton = document.createElement('button');
    voidButton.type = 'submit';
    voidButton.textContent = 'Manuelle Buchung stornieren';
    voidForm.append(voidButton);
    voidForm.addEventListener('submit', event => {
      event.preventDefault();
      submitEntryChange(entry, voidForm, null, voidButton);
    });
    actions.append(voidForm);
  }
  return actions;
}

async function submitEntryChange(entry, form, replacement, button) {
  if (!form.reportValidity()) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/admin/accounting/${encodeURIComponent(entry.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: form.elements.reason.value.trim(), replacement })
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) {
      throw new Error(result.message || 'Die Änderung konnte nicht gespeichert werden.');
    }
    showStatus(replacement
      ? `Korrektur gespeichert. Neue Buchungs-ID: ${result.corrected.id}. Die ursprüngliche Buchung bleibt im Prüfprotokoll.`
      : 'Buchung storniert und im Prüfprotokoll vermerkt.', 'success');
    await loadLedger();
  } catch (error) {
    showStatus(error.message || 'Die Änderung konnte nicht gespeichert werden.', 'error');
  } finally {
    button.disabled = false;
  }
}

async function loadLedger() {
  if (loading) {
    reloadPending = true;
    return;
  }
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
    if (reloadPending) {
      reloadPending = false;
      void loadLedger();
    }
  }
}

manualEntryForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!manualEntryForm.reportValidity()) return;
  const button = manualEntryForm.querySelector('button[type="submit"]');
  const payload = {
    kind: manualEntryForm.elements.kind.value,
    amount: Number(manualEntryForm.elements.amount.value),
    description: manualEntryForm.elements.description.value.trim(),
    sourceId: manualSourceId
  };
  button.disabled = true;
  manualEntryFeedback.textContent = 'Buchung wird gespeichert …';
  try {
    const response = await fetch('/api/admin/accounting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) {
      throw new Error(result.message || 'Die Buchung konnte nicht gespeichert werden.');
    }
    manualEntryForm.reset();
    manualSourceId = window.crypto.randomUUID();
    manualEntryFeedback.textContent = `Buchung gespeichert. ID: ${result.entry.id}`;
    showStatus('Manuelle Buchung gespeichert.', 'success');
    await loadLedger();
  } catch (error) {
    manualEntryFeedback.textContent = error.message || 'Die Buchung konnte nicht gespeichert werden.';
    showStatus(manualEntryFeedback.textContent, 'error');
  } finally {
    button.disabled = false;
  }
});

periodFilter.addEventListener('change', loadLedger);
document.getElementById('refresh-ledger').addEventListener('click', loadLedger);
loadLedger();
window.setInterval(loadLedger, 30_000);

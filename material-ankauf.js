const technicalInput = document.getElementById('technical');
const medicalInput = document.getElementById('medical');
const totalMaterialsInput = document.getElementById('total-materials');
const summaryTechnical = document.getElementById('summary-technical');
const summaryMedical = document.getElementById('summary-medical');
const summaryTotal = document.getElementById('summary-total');
const form = document.getElementById('order-form');
const statusBox = document.getElementById('status');
const numberFormatter = new Intl.NumberFormat('de-DE');

function formatPrice(value) {
  return `${numberFormatter.format(value)}$`;
}

function normalizeStepValue(value) {
  const raw = String(value).trim();
  if (raw === '') return '';

  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return '0';
  }

  const snapped = Math.round(numeric / 250) * 250;
  return String(snapped);
}

function updateSummary() {
  const technical = Math.max(0, Number(technicalInput.value) || 0);
  const medical = Math.max(0, Number(medicalInput.value) || 0);
  const totalMaterials = technical + medical;
  const technicalPrice = technical * 250;
  const medicalPrice = medical * 150;
  const totalPrice = technicalPrice + medicalPrice;

  totalMaterialsInput.value = totalMaterials;
  summaryTechnical.textContent = `${numberFormatter.format(technical)} × 250$ = ${formatPrice(technicalPrice)}`;
  summaryMedical.textContent = `${numberFormatter.format(medical)} × 150$ = ${formatPrice(medicalPrice)}`;
  summaryTotal.textContent = formatPrice(totalPrice);
}

[technicalInput, medicalInput].forEach((input) => {
  input.addEventListener('focus', () => {
    if (input.value === '0') input.value = '';
  });

  input.addEventListener('blur', () => {
    if (input.value === '') {
      input.value = '0';
    } else {
      input.value = normalizeStepValue(input.value);
    }
    updateSummary();
  });

  input.addEventListener('input', () => {
    const raw = input.value.trim();
    if (raw === '') {
      updateSummary();
      return;
    }

    const normalized = normalizeStepValue(raw);
    if (normalized !== raw) {
      input.value = normalized;
    }
    updateSummary();
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const technical = Math.max(0, Number(technicalInput.value) || 0);
  const medical = Math.max(0, Number(medicalInput.value) || 0);
  const icName = document.getElementById('ic-name').value.trim();
  const phone = document.getElementById('phone').value.trim();

  if (!icName) {
    statusBox.textContent = 'Bitte gib deinen IC-Namen ein.';
    statusBox.className = 'status error';
    return;
  }

  if (!phone) {
    statusBox.textContent = 'Bitte gib eine Handynummer ein.';
    statusBox.className = 'status error';
    return;
  }

  if (technical === 0 && medical === 0) {
    statusBox.textContent = 'Bitte gib mindestens eine Materialmenge ein.';
    statusBox.className = 'status error';
    return;
  }

  const payload = {
    technical,
    medical,
    icName,
    phone,
    totalMaterials: technical + medical,
    totalPrice: technical * 250 + medical * 150
  };

  statusBox.textContent = 'Bestellung wird gesendet...';
  statusBox.className = 'status';

  try {
    const response = await fetch('/api/material-bestellung', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || result.ok === false) {
      throw new Error(result.message || 'Bestellung konnte nicht gesendet werden.');
    }

    statusBox.textContent = result.message || `Bestellung erfolgreich gesendet. Gesamtpreis: ${result.total} $.`;
    statusBox.className = 'status success';
    form.reset();
    technicalInput.value = '0';
    medicalInput.value = '0';
    document.getElementById('ic-name').value = '';
    document.getElementById('phone').value = '';
    updateSummary();
  } catch (error) {
    statusBox.textContent = error.message || 'Fehler beim Senden der Bestellung.';
    statusBox.className = 'status error';
  }
});

updateSummary();

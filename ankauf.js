"use strict";

const form = document.getElementById("sell-offer-form");
const statusBox = document.getElementById("status");
const submitButton = form.querySelector('button[type="submit"]');

form.addEventListener("submit", async event => {
  event.preventDefault();

  const payload = {
    offer: document.getElementById("offer").value.trim(),
    icName: document.getElementById("ic-name").value.trim(),
    phone: document.getElementById("phone").value.trim()
  };

  statusBox.textContent = "Angebot wird gesendet...";
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
      throw new Error(result.message || "Angebot konnte nicht gesendet werden.");
    }

    statusBox.textContent = result.message || "Dein Angebot wurde gesendet.";
    statusBox.className = "status success";
    form.reset();
  } catch (error) {
    statusBox.textContent = error.message || "Fehler beim Senden des Angebots.";
    statusBox.className = "status error";
  } finally {
    submitButton.disabled = false;
  }
});

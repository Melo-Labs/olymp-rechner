# Produktions Rechner

## Discord-Zugriff einrichten

Der Rechner und die Produktverwaltung werden vom Node-Server ausgeliefert. Der Shop ist öffentlich, die Produktverwaltung erfordert eine erfolgreiche Discord-Anmeldung und die separat konfigurierte Katalog-Admin-Rolle.

1. Node.js 18.17 oder neuer installieren.
2. Im Discord Developer Portal eine Application erstellen und unter OAuth2 als Redirect URI `http://localhost:3000/auth/callback` eintragen.
3. Die IDs der Discord-Application, des Servers und der benötigten Rolle ermitteln. Für Server- und Rollen-IDs muss der Discord-Entwicklermodus aktiviert sein.
4. In `.env` `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID`, `DISCORD_ROLE_ID` und `DISCORD_PUBLIC_KEY` eintragen. Für die Produktverwaltung eine eigene Discord-Rolle erstellen und deren ID in `DISCORD_CATALOG_ADMIN_ROLE_ID` eintragen. Das Client-Secret niemals in Frontend-Dateien oder Git speichern.
5. Für Kontakt- und Statusbuttons in Material-, STANK- und Wunsch-Bestellungen sowie Ankauf-Angeboten den öffentlichen App-Key der Application als `DISCORD_PUBLIC_KEY` hinterlegen und `https://<deine-domain>/api/discord-interactions` als Discord-Interactions-Endpoint eintragen. Statusänderungen über Discord sind auf Mitglieder mit der Katalog-Admin-Rolle beschränkt.
6. Mit `npm start` starten und `http://localhost:3000` öffnen.

Für Zugriffsprotokolle den Discord-Bot der Application in den Server einladen und ihm in den beiden Log-Channels die Berechtigungen „Kanal ansehen“, „Nachrichten senden“ und „Links einbetten“ geben. Den Bot-Token als `DISCORD_BOT_TOKEN` eintragen. `DISCORD_ALLOWED_LOG_CHANNEL_ID` ist das Ziel für erlaubte Anmeldungen, `DISCORD_DENIED_LOG_CHANNEL_ID` das Ziel für abgelehnte Rollenprüfungen. Den Bot-Token wie ein Passwort behandeln und niemals in Git oder im Frontend speichern. Erfolgreiche Anmeldungen und abgelehnte Rollenprüfungen protokollieren Discord-Name, User-ID, Profilbild (falls vorhanden), Ergebnis und Zeit. Abgebrochene Anmeldungen können keinem Discord-Profil zugeordnet werden.

Beim Beitritt zum Server vergibt der Bot automatisch die Unverified-Rolle `1558193824386261192` und sendet ein Welcome-Embed mit `img/willkommen.png` in den Kanal `1558193685860982880`. Dafür im Discord Developer Portal unter „Bot“ den privilegierten **Server Members Intent** aktivieren. Die Bot-Rolle braucht „Rollen verwalten“ und muss in der Rollenliste oberhalb der Unverified-Rolle stehen; im Willkommenskanal braucht sie „Kanal ansehen“, „Nachrichten senden“ und „Links einbetten“.

Materialbestellungen werden an `DISCORD_ORDER_CHANNEL_ID` gesendet (Standard: `1558426870465302538`). Ankauf-Angebote aus `/ankauf.html` werden standardmäßig an `1558812539805110434` gesendet; das Ziel kann mit `DISCORD_SELL_OFFER_CHANNEL_ID` überschrieben werden. STANK-Bestellungen gehen an den festgelegten STANK-Kanal `1558497954921193592`. Wunsch-Bestellungen mit frei eingegebenen Gegenständen und Preisvorschlägen gehen an `1558508937400291338`. Der Bot benötigt in allen Bestell-Channels die Berechtigungen „Kanal ansehen“, „Nachrichten senden“ und „Links einbetten“. Material-, STANK- und Wunschbestellungen sowie Ankauf-Angebote werden dauerhaft in `data/admin-orders.json` gespeichert und sind unter `/admin/orders` einsehbar. Dort können berechtigte Admins den Status auf Neu, Angenommen, In Bearbeitung, Erledigt oder Abgelehnt setzen; Discord-Nachrichten werden dabei ebenfalls aktualisiert. „Angenommen“ und „Abgelehnt“ schließen den Auftrag ab und entfernen alle Discord-Buttons; abgeschlossene Aufträge können auch in der Adminseite nicht mehr geändert werden. Discord-Statusbuttons akzeptieren nur Mitglieder mit der Rolle `DISCORD_CATALOG_ADMIN_ROLE_ID`. Bei Hosting mit flüchtigem Dateisystem muss auch für `data/admin-orders.json` ein persistentes Volume eingebunden sein; mit `ADMIN_ORDERS_FILE` kann der Speicherort angepasst werden. Eine STANK-Pflanze kostet 2.000 $.

Eine Tagesbuchhaltung wird täglich ab 00:05 Uhr (Zeitzone `Europe/Berlin`) für den Vortag als Embed in Kanal `1559327859351232603` veröffentlicht. Sie summiert die erfassten Material-, STANK- und Wunschbestellungen. Ankauf-Angebote sind ausgeschlossen; die Werte sind Bestellsummen und keine bestätigten Zahlungseingänge. Der Bot benötigt im Buchhaltungskanal die Berechtigungen „Kanal ansehen“, „Nachrichten senden“ und „Links einbetten“. Das lokale Buchungsjournal und der Versandstatus liegen in `data/accounting-orders.json` und `data/accounting-reports.json`; bei Hosting mit flüchtigem Dateisystem müssen diese Daten persistent gespeichert werden.

Der Shop unter `/freie-bestellung.html` kombiniert feste Produkte mit frei ergänzbaren Wunschpositionen. Feste Produkte und Preise werden unter `/admin/catalog` gepflegt; Bestellungen werden unter `/admin/orders` verwaltet. Für beide Verwaltungsseiten und Statusänderungen ist die Rolle `DISCORD_CATALOG_ADMIN_ROLE_ID` erforderlich. Änderungen an Produkten (Hinzufügen, Bearbeiten, Aktivieren/Deaktivieren und Entfernen) werden mit Discord-Anzeigename und User-ID im Audit-Channel `1558539114662330419` protokolliert. Der Bot braucht dort die Berechtigungen „Kanal ansehen“ und „Nachrichten senden“. Bei einem Discord-Fehler wird die Änderung als gespeichert angezeigt, aber die Admin-Seite weist ausdrücklich darauf hin, dass das Audit-Log nicht gesendet werden konnte. Der Server speichert den Katalog in `shop-products.json`. Bei Hosting mit flüchtigem Dateisystem (z. B. ohne eingebundenen Persistent Disk) muss für dauerhafte Produkt- und Bestelldaten ein persistentes Volume verwendet werden.

Wochenangebote und Randwerbung werden bewusst im Quellcode gepflegt und bleiben dadurch mit dem Deployment erhalten. Das Bildangebot wird unter `WEEKLY_BUNDLE` in `server.js` mit ID, Name und Festpreis gepflegt; sein Button legt das Bundle in den Warenkorb und der Server setzt den hinterlegten Preis beim Bestellen verbindlich. Produkt-Rabatte können unter `SHOP_CONTENT.weeklyOffers` mit Produkt-ID, Angebotspreis und optionaler Beschriftung ergänzt werden, zum Beispiel `{ productId: "11111111-1111-4111-8111-111111111111", price: 28000, label: "Wochenangebot" }`. Der Angebotspreis muss unter dem normalen Katalogpreis liegen; Warenkorb und Bestellserver verwenden denselben rabattierten Preis. Randwerbung kommt in `SHOP_CONTENT.ads`, zum Beispiel `{ title: "Aktion", text: "Mehr erfahren", image: "/img/aktion.jpg", href: "https://example.com", linkLabel: "Jetzt ansehen" }`. Mehrere Werbeeinträge werden rechts alle sechs Sekunden durchgewechselt und können über Punkte manuell ausgewählt werden; bei aktivierter Betriebssystem-Einstellung „Bewegung reduzieren“ läuft der automatische Wechsel nicht. Nicht benötigte Felder wie Bild, Text und Linkbeschriftung können entfallen. Nach Änderungen an `server.js` den Server neu starten.

Der Login verwendet den OAuth2-Scope `identify`. Die Rollenprüfung erfolgt über den Discord-Bot, der Servermitgliedschaften lesen können muss. Die Rolle wird bei der Anmeldung und danach mindestens einmal pro Minute geprüft. Sitzungen laufen nach acht Stunden ab und werden beim Serverneustart beendet.

## Git-Push-Benachrichtigung per Discord-Webhook

Für jede erfolgreiche `git push`-Operation wird eine Discord-Nachricht an einen Webhook gesendet. Dafür wird ein Git-Hook unter `.githooks/post-push` verwendet.

1. In der Datei `.env` die Variable `DISCORD_PUSH_WEBHOOK_URL` mit dem Discord-Webhook-Link eintragen.
2. Hook aktivieren:
   `git config core.hooksPath .githooks`
3. Datei ausführbar machen:
   `chmod +x .githooks/post-push scripts/notify-discord-push.js`

Nach dem nächsten `git push` erscheint im Discord-Channel eine Nachricht mit Repository, Zweig, Remote und den letzten Commits.

## Hosting

Für öffentliches Hosting die Redirect URI im Developer Portal und in `.env` auf dieselbe HTTPS-Adresse setzen. `HOST` auf `0.0.0.0` setzen, damit der Hosting-Anbieter den Prozess erreichen kann, und `SESSION_COOKIE_SECURE=true` aktivieren. Das Client-Secret und `DISCORD_BOT_TOKEN` ausschließlich als geschützte Umgebungsvariablen des Hostings hinterlegen.
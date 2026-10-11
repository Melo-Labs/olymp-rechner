# Produktions Rechner

## Discord-Zugriff einrichten

Der Rechner und die Produktverwaltung werden vom Node-Server ausgeliefert. Der Shop ist öffentlich, die Produktverwaltung erfordert eine erfolgreiche Discord-Anmeldung und die separat konfigurierte Katalog-Admin-Rolle.

1. Node.js 18.17 oder neuer installieren.
2. Im Discord Developer Portal eine Application erstellen und unter OAuth2 als Redirect URI `http://localhost:3000/auth/callback` eintragen.
3. Die IDs der Discord-Application, des Servers und der benötigten Rolle ermitteln. Für Server- und Rollen-IDs muss der Discord-Entwicklermodus aktiviert sein.
4. In `.env` `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID`, `DISCORD_ROLE_ID` und `DISCORD_PUBLIC_KEY` eintragen. Für die Produktverwaltung eine eigene Discord-Rolle erstellen und deren ID in `DISCORD_CATALOG_ADMIN_ROLE_ID` eintragen. Das Client-Secret niemals in Frontend-Dateien oder Git speichern.
5. Für Discord-Buttons im Material-Bestell-Embed zusätzlich den öffentlichen App-Key der Application als `DISCORD_PUBLIC_KEY` hinterlegen. Die Interaktions-Route wird dann über `POST /api/discord-interactions` verarbeitet.
6. Mit `npm start` starten und `http://localhost:3000` öffnen.

Für Zugriffsprotokolle den Discord-Bot der Application in den Server einladen und ihm in den beiden Log-Channels die Berechtigungen „Kanal ansehen“, „Nachrichten senden“ und „Links einbetten“ geben. Den Bot-Token als `DISCORD_BOT_TOKEN` eintragen. `DISCORD_ALLOWED_LOG_CHANNEL_ID` ist das Ziel für erlaubte Anmeldungen, `DISCORD_DENIED_LOG_CHANNEL_ID` das Ziel für abgelehnte Rollenprüfungen. Den Bot-Token wie ein Passwort behandeln und niemals in Git oder im Frontend speichern. Erfolgreiche Anmeldungen und abgelehnte Rollenprüfungen protokollieren Discord-Name, User-ID, Profilbild (falls vorhanden), Ergebnis und Zeit. Abgebrochene Anmeldungen können keinem Discord-Profil zugeordnet werden.

Materialbestellungen werden an `DISCORD_ORDER_CHANNEL_ID` gesendet (Standard: `1558426870465302538`). STANK-Bestellungen gehen an den festgelegten STANK-Kanal `1558497954921193592`. Wunsch-Bestellungen mit frei eingegebenen Gegenständen und Preisvorschlägen gehen an `1558508937400291338`. Der Bot benötigt in allen Bestell-Channels die Berechtigungen „Kanal ansehen“, „Nachrichten senden“ und „Links einbetten“. Bestellungen werden an Discord gesendet; eine persistente Bestellübersicht im Adminbereich gibt es nicht. Eine STANK-Pflanze kostet 2.000 $.

Der Shop unter `/freie-bestellung.html` kombiniert feste Produkte mit frei ergänzbaren Wunschpositionen. Feste Produkte und Preise werden unter `/admin/catalog` gepflegt; für diese Verwaltung ist die Rolle `DISCORD_CATALOG_ADMIN_ROLE_ID` erforderlich. Änderungen an Produkten (Hinzufügen, Bearbeiten, Aktivieren/Deaktivieren und Entfernen) werden mit Discord-Anzeigename und User-ID im Audit-Channel `1558539114662330419` protokolliert. Der Bot braucht dort die Berechtigungen „Kanal ansehen“ und „Nachrichten senden“. Bei einem Discord-Fehler wird die Änderung als gespeichert angezeigt, aber die Admin-Seite weist ausdrücklich darauf hin, dass das Audit-Log nicht gesendet werden konnte. Der Server speichert den Katalog in `shop-products.json`. Bei Hosting mit flüchtigem Dateisystem (z. B. ohne eingebundenen Persistent Disk) muss für dauerhafte Produktdaten ein persistentes Volume verwendet werden.

Der Login verwendet den OAuth2-Scope `identify`. Die Rollenprüfung erfolgt über den Discord-Bot, der Servermitgliedschaften lesen können muss. Die Rolle wird bei der Anmeldung und danach mindestens einmal pro Minute geprüft. Sitzungen laufen nach acht Stunden ab und werden beim Serverneustart beendet.

## Hosting

Für öffentliches Hosting die Redirect URI im Developer Portal und in `.env` auf dieselbe HTTPS-Adresse setzen. `HOST` auf `0.0.0.0` setzen, damit der Hosting-Anbieter den Prozess erreichen kann, und `SESSION_COOKIE_SECURE=true` aktivieren. Das Client-Secret und `DISCORD_BOT_TOKEN` ausschließlich als geschützte Umgebungsvariablen des Hostings hinterlegen.
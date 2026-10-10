# Produktions Rechner

## Discord-Zugriff einrichten

Der Rechner wird vom Node-Server ausgeliefert. HTML, JavaScript, Stylesheets und Bilder sind nur nach erfolgreicher Discord-Rollenprüfung erreichbar.

1. Node.js 18.17 oder neuer installieren.
2. Im Discord Developer Portal eine Application erstellen und unter OAuth2 als Redirect URI `http://localhost:3000/auth/callback` eintragen.
3. Die IDs der Discord-Application, des Servers und der benötigten Rolle ermitteln. Für Server- und Rollen-IDs muss der Discord-Entwicklermodus aktiviert sein.
4. In `.env` `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID`, `DISCORD_ROLE_ID` und `DISCORD_PUBLIC_KEY` eintragen. Das Client-Secret niemals in Frontend-Dateien oder Git speichern.
5. Für Discord-Buttons im Material-Bestell-Embed zusätzlich den öffentlichen App-Key der Application als `DISCORD_PUBLIC_KEY` hinterlegen. Die Interaktions-Route wird dann über `POST /api/discord-interactions` verarbeitet.
6. Mit `npm start` starten und `http://localhost:3000` öffnen.

Für Zugriffsprotokolle den Discord-Bot der Application in den Server einladen und ihm in den beiden Log-Channels die Berechtigungen „Kanal ansehen“, „Nachrichten senden“ und „Links einbetten“ geben. Den Bot-Token als `DISCORD_BOT_TOKEN` eintragen. `DISCORD_ALLOWED_LOG_CHANNEL_ID` ist das Ziel für erlaubte Anmeldungen, `DISCORD_DENIED_LOG_CHANNEL_ID` das Ziel für abgelehnte Rollenprüfungen. Den Bot-Token wie ein Passwort behandeln und niemals in Git oder im Frontend speichern. Erfolgreiche Anmeldungen und abgelehnte Rollenprüfungen protokollieren Discord-Name, User-ID, Profilbild (falls vorhanden), Ergebnis und Zeit. Abgebrochene Anmeldungen können keinem Discord-Profil zugeordnet werden.

Der Login verwendet die OAuth2-Scopes `identify` und `guilds.members.read`; ein Discord-Bot ist für diese Rollenprüfung nicht erforderlich. Die Rolle wird bei der Anmeldung und danach mindestens einmal pro Minute geprüft. Sitzungen laufen nach acht Stunden ab und werden beim Serverneustart beendet.

## Hosting

Für öffentliches Hosting die Redirect URI im Developer Portal und in `.env` auf dieselbe HTTPS-Adresse setzen. `HOST` auf `0.0.0.0` setzen, damit der Hosting-Anbieter den Prozess erreichen kann, und `SESSION_COOKIE_SECURE=true` aktivieren. Das Client-Secret und `DISCORD_BOT_TOKEN` ausschließlich als geschützte Umgebungsvariablen des Hostings hinterlegen.
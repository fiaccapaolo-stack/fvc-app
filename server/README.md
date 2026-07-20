# Fvc Project Srl — Server

Questo server fa due cose:
1. Serve la app (la cartella sopra a questa, con `index.html`, `manifest.json`, ecc.)
2. Manda una notifica push a tutti i clienti iscritti ogni volta che aggiungi una nuova offerta

## Avvio (in locale, per provare)

```
cd server
npm install
npm start
```

Poi apri `http://localhost:3000` dal telefono (stessa rete Wi-Fi) o da computer.
Al primo avvio il server genera da solo le chiavi di sicurezza per le notifiche
(`server/data/vapid-keys.json`) — non cancellare quel file dopo, altrimenti tutti
i clienti già iscritti smettono di ricevere notifiche.

## Come aggiungere un'offerta (e notificare tutti automaticamente)

Apri `server/data/offers.json` e aggiungi una voce, ad esempio:

```json
{
  "id": "black-friday-2026",
  "pct": "-30%",
  "title": "Black Friday su tutti gli smartphone",
  "desc": "Solo per questa settimana.",
  "heat": 4
}
```

Regole importanti:
- `id` deve essere unico e non deve mai cambiare per un'offerta già pubblicata
  (è come il server capisce se è "nuova" o già notificata).
- Appena salvi il file, il server se ne accorge da solo e manda la notifica
  push a tutti i clienti iscritti — non serve fare nient'altro.
- Per togliere un'offerta scaduta, rimuovi semplicemente la sua voce dal file:
  non genera nessuna notifica in uscita.

## Dove metterlo online

Serve un hosting che possa far girare Node.js in continuo (non va bene un hosting
"solo file statici"). Opzioni comuni, dalla più semplice:
- **Render.com** o **Railway.app**: colleghi la cartella `server/`, imposta
  `npm install` come build e `npm start` come avvio, gratuito per iniziare.
- Un VPS (es. Hetzner, DigitalOcean) con Node.js installato e `pm2` per tenerlo
  sempre attivo.

Una volta online, l'indirizzo del server (es. `https://tuonegozio.onrender.com`)
è anche l'indirizzo della app: è la stessa cosa, il server serve tutto insieme.

## File di dati

- `data/offers.json` — le offerte mostrate nella app (lo modifichi tu)
- `data/subscriptions.json` — i telefoni iscritti alle notifiche (gestito dal server)
- `data/notified.json` — quali offerte sono già state notificate (gestito dal server)
- `data/vapid-keys.json` — chiavi private del server, non condividerle e non cancellarle

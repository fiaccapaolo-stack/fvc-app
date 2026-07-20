// Server Fvc Project Srl
// - Serve i file della PWA (index.html, manifest, service worker, icone)
// - Riceve le iscrizioni alle notifiche dai telefoni dei clienti
// - Quando aggiungi un'offerta in data/offers.json, se ne accorge da solo
//   e manda la notifica push a tutti gli iscritti, senza bisogno di alcuna
//   azione manuale.

const express = require("express");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, ".."); // cartella della PWA (index.html, sw.js, ecc.)
const DATA_DIR = path.join(__dirname, "data");
const OFFERS_FILE = path.join(DATA_DIR, "offers.json");
const SUBS_FILE = path.join(DATA_DIR, "subscriptions.json");
const NOTIFIED_FILE = path.join(DATA_DIR, "notified.json");
const KEYS_FILE = path.join(DATA_DIR, "vapid-keys.json");

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---- Chiavi VAPID: generate automaticamente al primo avvio, poi riusate.
// Non cancellare data/vapid-keys.json dopo la prima generazione: se lo perdi,
// tutti i clienti gia' iscritti smettono di ricevere notifiche e dovranno
// riattivarle.
let vapidKeys = readJSON(KEYS_FILE, null);
if (!vapidKeys) {
  vapidKeys = webpush.generateVAPIDKeys();
  writeJSON(KEYS_FILE, vapidKeys);
  console.log("Nuove chiavi VAPID generate in server/data/vapid-keys.json — non cancellarle.");
}
webpush.setVapidDetails(
  "mailto:negozio@example.com", // sostituisci con una tua email di contatto
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

const app = express();
app.use(express.json());
app.use(express.static(ROOT));

// Chiave pubblica richiesta dal browser per iscriversi alle notifiche
app.get("/api/vapid-public-key", (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// Elenco offerte per popolare la sezione "Offerte" della app
app.get("/api/offers", (req, res) => {
  res.json(readJSON(OFFERS_FILE, []));
});

// Un cliente attiva le notifiche dal suo telefono
app.post("/api/subscribe", (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) {
    return res.status(400).json({ error: "Iscrizione non valida" });
  }
  const subs = readJSON(SUBS_FILE, []);
  if (!subs.find((s) => s.endpoint === sub.endpoint)) {
    subs.push(sub);
    writeJSON(SUBS_FILE, subs);
    console.log(`Nuovo iscritto alle notifiche (totale: ${subs.length})`);
  }
  res.status(201).json({ ok: true });
});

// Un cliente disattiva le notifiche
app.post("/api/unsubscribe", (req, res) => {
  const { endpoint } = req.body || {};
  const subs = readJSON(SUBS_FILE, []).filter((s) => s.endpoint !== endpoint);
  writeJSON(SUBS_FILE, subs);
  res.json({ ok: true });
});

async function sendToAll(payload) {
  const subs = readJSON(SUBS_FILE, []);
  const survivors = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      survivors.push(sub);
    } catch (err) {
      const code = err.statusCode;
      if (code === 404 || code === 410) {
        // Il cliente ha disinstallato l'app o disattivato le notifiche:
        // rimuoviamo l'iscrizione scaduta, in silenzio.
      } else {
        console.error("Errore invio notifica:", code, err.body);
        survivors.push(sub); // riprova al prossimo invio
      }
    }
  }
  writeJSON(SUBS_FILE, survivors);
}

// Confronta le offerte presenti con quelle gia' notificate in passato.
// Ogni offerta nuova (id non ancora visto) genera una notifica automatica.
function checkForNewOffers() {
  const offers = readJSON(OFFERS_FILE, []);
  const notified = readJSON(NOTIFIED_FILE, []);
  const newOnes = offers.filter((o) => !notified.includes(o.id));
  if (newOnes.length === 0) return;

  newOnes.forEach((offer) => {
    console.log("Nuova offerta rilevata, invio notifica:", offer.title);
    sendToAll({
      title: `Fvc Project · ${offer.pct}`,
      body: offer.title,
    });
  });

  writeJSON(NOTIFIED_FILE, [...notified, ...newOnes.map((o) => o.id)]);
}

// Controlla all'avvio, poi ogni volta che il file offers.json viene salvato
checkForNewOffers();
let debounceTimer;
fs.watch(OFFERS_FILE, () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(checkForNewOffers, 500);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Fvc Project attivo su http://localhost:${PORT}`);
});

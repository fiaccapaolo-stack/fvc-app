// Server Fvc Project Srl
// - Serve i file della PWA (index.html, manifest, service worker, icone)
// - Serve il pannello di gestione offerte protetto da password (admin.html)
// - Riceve le iscrizioni alle notifiche dai telefoni dei clienti
// - Quando crei una nuova offerta dal pannello, la notifica parte in automatico
//
// Tutti i dati (offerte, iscrizioni, offerte gia' notificate, chiavi di
// sicurezza) sono salvati su Upstash Redis, un database gratuito che non
// si cancella mai a ogni riavvio o nuovo deploy di Render.

const express = require("express");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");
const { Redis } = require("@upstash/redis");

const ROOT = path.join(__dirname, ".."); // cartella della PWA (index.html, sw.js, ecc.)
const DATA_DIR = path.join(__dirname, "data");
const SEED_OFFERS_FILE = path.join(DATA_DIR, "offers.json"); // solo per il primo avvio

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error(
    "Mancano le variabili UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN.\n" +
    "Vai su upstash.com, crea un database Redis gratuito e imposta queste due\n" +
    "variabili d'ambiente su Render (vedi README.md)."
  );
}
if (!process.env.ADMIN_PASSWORD) {
  console.warn(
    "ATTENZIONE: variabile ADMIN_PASSWORD non impostata. Il pannello di " +
    "gestione offerte (admin.html) non sara' accessibile finche' non la imposti."
  );
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// ---- Chiavi VAPID: generate una sola volta e salvate su Redis ----
async function getVapidKeys() {
  const stored = await redis.get("vapid_keys");
  if (stored) return typeof stored === "string" ? JSON.parse(stored) : stored;
  const keys = webpush.generateVAPIDKeys();
  await redis.set("vapid_keys", JSON.stringify(keys));
  console.log("Nuove chiavi VAPID generate e salvate su Upstash (una sola volta).");
  return keys;
}

// ---- Iscrizioni alle notifiche: hash Redis, chiave = endpoint del browser ----
async function getSubscriptions() {
  const all = await redis.hgetall("subscriptions");
  if (!all) return [];
  return Object.values(all).map((v) => (typeof v === "string" ? JSON.parse(v) : v));
}
async function addSubscription(sub) {
  await redis.hset("subscriptions", { [sub.endpoint]: JSON.stringify(sub) });
}
async function removeSubscription(endpoint) {
  await redis.hdel("subscriptions", endpoint);
}

// ---- Offerte: hash Redis, chiave = id dell'offerta ----
async function getOffers() {
  const all = await redis.hgetall("offers");
  if (!all) return [];
  const offers = Object.values(all).map((v) => (typeof v === "string" ? JSON.parse(v) : v));
  offers.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return offers;
}
async function saveOffer(offer) {
  await redis.hset("offers", { [offer.id]: JSON.stringify(offer) });
}
async function deleteOffer(id) {
  await redis.hdel("offers", id);
}
// Al primissimo avvio in assoluto, se su Redis non c'e' ancora nessuna
// offerta, importiamo le 3 di esempio dal file locale (non generano notifica:
// sono solo il punto di partenza).
async function seedOffersIfEmpty() {
  const existing = await getOffers();
  if (existing.length > 0) return;
  const seed = readJSON(SEED_OFFERS_FILE, []);
  for (const offer of seed) {
    await saveOffer({ ...offer, createdAt: Date.now() });
  }
  if (seed.length) console.log(`Importate ${seed.length} offerte di esempio su Upstash.`);
}

async function sendToAll(payload) {
  const subs = await getSubscriptions();
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (err) {
      const code = err.statusCode;
      if (code === 404 || code === 410) {
        await removeSubscription(sub.endpoint); // iscrizione scaduta
      } else {
        console.error("Errore invio notifica:", code, err.body);
      }
    }
  }
}

function requireAdmin(req, res, next) {
  const provided = req.header("x-admin-password");
  if (!process.env.ADMIN_PASSWORD || provided !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Password non corretta" });
  }
  next();
}

async function main() {
  const vapidKeys = await getVapidKeys();
  webpush.setVapidDetails(
    "mailto:negozio@example.com", // sostituisci con una tua email di contatto
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
  await seedOffersIfEmpty();

  const app = express();
  app.use(express.json());
  app.use(express.static(ROOT));

  // ---- endpoint pubblici, usati dalla app dei clienti ----
  app.get("/api/vapid-public-key", (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
  });

  app.get("/api/offers", async (req, res) => {
    res.json(await getOffers());
  });

  app.post("/api/subscribe", async (req, res) => {
    const sub = req.body;
    if (!sub || !sub.endpoint) {
      return res.status(400).json({ error: "Iscrizione non valida" });
    }
    await addSubscription(sub);
    res.status(201).json({ ok: true });
  });

  app.post("/api/unsubscribe", async (req, res) => {
    const { endpoint } = req.body || {};
    if (endpoint) await removeSubscription(endpoint);
    res.json({ ok: true });
  });

  // ---- endpoint del pannello di gestione, protetti da password ----
  app.post("/api/admin/check", requireAdmin, (req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/admin/offers", requireAdmin, async (req, res) => {
    res.json(await getOffers());
  });

  app.post("/api/admin/offers", requireAdmin, async (req, res) => {
    const { id, pct, title, desc, heat } = req.body || {};
    if (!id || !pct || !title) {
      return res.status(400).json({ error: "Compila almeno id, sconto e titolo" });
    }
    const existing = await getOffers();
    if (existing.find((o) => o.id === id)) {
      return res.status(409).json({ error: "Esiste gia' un'offerta con questo id" });
    }
    const offer = { id, pct, title, desc: desc || "", heat: Number(heat) || 1, createdAt: Date.now() };
    await saveOffer(offer);
    console.log("Nuova offerta creata dal pannello, invio notifica:", offer.title);
    await sendToAll({ title: `Fvc Project · ${offer.pct}`, body: offer.title });
    res.status(201).json(offer);
  });

  app.put("/api/admin/offers/:id", requireAdmin, async (req, res) => {
    const { id } = req.params;
    const existing = await getOffers();
    const current = existing.find((o) => o.id === id);
    if (!current) return res.status(404).json({ error: "Offerta non trovata" });
    const { pct, title, desc, heat } = req.body || {};
    const updated = {
      ...current,
      pct: pct ?? current.pct,
      title: title ?? current.title,
      desc: desc ?? current.desc,
      heat: heat !== undefined ? Number(heat) : current.heat,
    };
    await saveOffer(updated); // modificare un'offerta esistente non genera notifica
    res.json(updated);
  });

  app.delete("/api/admin/offers/:id", requireAdmin, async (req, res) => {
    await deleteOffer(req.params.id);
    res.json({ ok: true });
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Fvc Project attivo su http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Errore all'avvio del server:", err);
  process.exit(1);
});

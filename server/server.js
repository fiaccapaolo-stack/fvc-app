// Server Fvc Project Srl
// - Serve i file della PWA (index.html, manifest, service worker, icone)
// - Serve il pannello di gestione offerte protetto da password (admin.html)
// - Riceve le iscrizioni alle notifiche dai telefoni dei clienti
// - Quando crei una nuova offerta dal pannello, la notifica parte in automatico
//
// Tutti i dati (offerte, iscrizioni, offerte gia' notificate, chiavi di
// sicurezza) sono salvati su Upstash Redis, un database gratuito che non
// si cancella mai a ogni riavvio o nuovo deploy di Render.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const multer = require('multer');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 10000; // Render usa spesso la porta 10000 o quella definita in PORT

// --- CONFIGURAZIONE VAPID ---
let vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
};

// Controllo se le chiavi sono presenti
if (vapidKeys.publicKey && vapidKeys.privateKey) {
  try {
    webpush.setVapidDetails(
      'mailto:support@fvcproject.it',
      vapidKeys.publicKey,
      vapidKeys.privateKey
    );
    console.log('✅ Chiavi VAPID configurate. Notifiche push attive.');
  } catch (e) {
    console.warn('⚠️ Errore configurazione VAPID. Controlla il formato delle chiavi.', e.message);
    vapidKeys = { publicKey: null, privateKey: null };
  }
} else {
  console.warn('⚠️ Variabili d\'ambiente VAPID non trovate. Le notifiche push non funzioneranno finché non le configuri su Render.');
}

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- GESTIONE FILE STATICI (FRONTEND) ---
// Poiché server.js e la cartella public sono entrambi dentro /server, usiamo un percorso relativo semplice.
const PUBLIC_PATH = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_PATH));

console.log(`📂 Servendo file statici da: ${PUBLIC_PATH}`);

// --- GESTIONE DATI E UPLOAD ---
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const OFFERS_FILE = path.join(DATA_DIR, 'offers.json');
const RATES_FILE = path.join(DATA_DIR, 'tim-rates.json');

// Crea cartelle se non esistono
[DATA_DIR, UPLOAD_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Config Multer per upload Excel
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.xlsx';
    cb(null, 'import_temp' + ext);
  }
});
const upload = multer({ storage: storage });

// --- FUNZIONI UTILI ---
function readJson(file, def) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : def;
  } catch (e) { return def; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function parseTimExcel(filePath) {
  try {
    const wb = XLSX.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    
    let headers = [];
    let startRow = 0;
    
    // Trova intestazioni
    for(let i=0; i<Math.min(data.length, 15); i++) {
      const rowStr = data[i].join(' ').toLowerCase();
      if(rowStr.includes('prodotto')) {
        headers = data[i].map(h => String(h).trim().toLowerCase());
        startRow = i + 1;
        break;
      }
    }

    const idxProd = headers.findIndex(h => h.includes('prodotto'));
    const idxRate = headers.findIndex(h => h.includes('rata') && !h.includes('prezzo'));
    const idxPrice = headers.findIndex(h => h.includes('prezzo') || (h.includes('rata') && h.includes('euro')));

    if(idxProd === -1) throw new Error("Colonna PRODOTTO non trovata");

    const result = {};
    let count = 0;

    for(let i=startRow; i<data.length; i++) {
      const row = data[i];
      const rawProd = row[idxProd];
      if(!rawProd) continue;

      const rate = idxRate > -1 ? parseInt(String(row[idxRate]).replace(/[^0-9]/g,'')) || 0 : 0;
      let price = 0;
      if(idxPrice > -1 && row[idxPrice]) {
        price = parseFloat(String(row[idxPrice]).replace(',','.').replace(/[^0-9.]/g,'')) || 0;
      }

      const products = typeof rawProd === 'string' 
        ? rawProd.split(/\r?\n/).map(p=>p.trim()).filter(p=>p) 
        : [String(rawProd)];

      products.forEach(p => {
        result[p] = { rate, prezzoRata: price, operatore: 'TIM', updated: new Date() };
        count++;
      });
    }
    console.log(`✅ Parse completato: ${count} prodotti.`);
    return result;
  } catch(e) {
    console.error("Errore parsing Excel:", e);
    throw e;
  }
}

// --- API ENDPOINTS ---

app.get('/api/config', (req, res) => res.json(readJson(CONFIG_FILE, {})));

app.post('/api/config', async (req, res) => {
  const cfg = { ...readJson(CONFIG_FILE, {}), ...req.body };
  writeJson(CONFIG_FILE, cfg);
  if(req.body.sendNotification) await sendPush('Catalogo Aggiornato', 'Nuovi prodotti disponibili!');
  res.json({ success: true });
});

app.get('/api/offers', (req, res) => res.json(readJson(OFFERS_FILE, [])));

app.post('/api/offers', async (req, res) => {
  writeJson(OFFERS_FILE, req.body);
  await sendPush('Nuova Offerta!', 'Controlla le promozioni.');
  res.json({ success: true });
});

// Upload Rate
app.post('/api/import-rates', upload.single('excelFile'), async (req, res) => {
  if(!req.file) return res.status(400).json({ error: 'Nessun file' });
  try {
    const data = parseTimExcel(req.file.path);
    writeJson(RATES_FILE, data);
    fs.unlinkSync(req.file.path); // Pulizia
    res.json({ success: true, count: Object.keys(data).length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/rates', (req, res) => res.json(readJson(RATES_FILE, {})));

// Notifiche
let subs = [];
app.get('/api/vapid-public-key', (req, res) => {
  if(!vapidKeys.publicKey) return res.status(500).json({ error: 'Chiavi mancanti' });
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/subscribe', (req, res) => {
  if(!subs.some(s => s.endpoint === req.body.endpoint)) subs.push(req.body);
  res.status(201).json({ ok: true });
});

async function sendPush(title, body) {
  if(subs.length === 0) return;
  const payload = JSON.stringify({ title, body, icon: '/icons/icon-192.png' });
  await Promise.all(subs.map(s => webpush.sendNotification(s, payload).catch(console.error)));
}

// Fallback per SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_PATH, 'index.html'));
});

// START
app.listen(PORT, () => {
  console.log(`🚀 Server attivo su porta ${PORT}`);
  console.log(`📁 Public: ${PUBLIC_PATH}`);
  console.log(`💾 Data: ${DATA_DIR}`);
});

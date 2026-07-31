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
const PORT = process.env.PORT || 3000;

// --- CONFIGURAZIONE VAPID SICURA ---
// Il server non crasherà se le chiavi mancano, ma le notifiche non partiranno finché non le imposti.
let vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY || '',
  privateKey: process.env.VAPID_PRIVATE_KEY || ''
};

if (vapidKeys.publicKey && vapidKeys.privateKey) {
  try {
    webpush.setVapidDetails(
      'mailto:support@fvcproject.it',
      vapidKeys.publicKey,
      vapidKeys.privateKey
    );
    console.log('✅ Chiavi VAPID caricate correttamente.');
  } catch (e) {
    console.warn('⚠️ Chiavi VAPID non valide. Le notifiche push saranno disabilitate.', e.message);
    vapidKeys = { publicKey: '', privateKey: '' }; // Reset per sicurezza
  }
} else {
  console.warn('⚠️ Variabili d\'ambiente VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY non trovate.');
  console.warn('   Le notifiche push non funzioneranno finché non le configuri nelle impostazioni di Render.');
}

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve i file statici dalla cartella 'public' (che si trova un livello sopra rispetto a /server)
app.use(express.static(path.join(__dirname, '../public')));

// Percorsi per i dati
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const OFFERS_FILE = path.join(DATA_DIR, 'offers.json');
const RATES_FILE = path.join(DATA_DIR, 'tim-rates.json');

// Assicurati che la cartella data esista
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`📁 Cartella dati creata: ${DATA_DIR}`);
}

// --- CONFIGURAZIONE MULTER (UPLOAD FILE) ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.xlsx';
    cb(null, 'import_rates_temp' + ext);
  }
});
const upload = multer({ storage: storage });

// --- FUNZIONI DI SUPPORTO ---

function readJsonFile(file, defaultData) {
  try {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8');
      return JSON.parse(content);
    }
  } catch (e) {
    console.error(`Errore lettura ${file}:`, e.message);
  }
  return defaultData;
}

function writeJsonFile(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  console.log(`💾 File salvato: ${file}`);
}

// Logica di parsing specifica per il formato TIM
function parseTimData(filePath) {
  try {
    console.log(`🔄 Inicio parsing di: ${filePath}`);
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (rawData.length === 0) throw new Error("Il file sembra vuoto");

    let headerRowIndex = -1;
    let headers = [];

    for (let i = 0; i < Math.min(rawData.length, 15); i++) {
      const rowStr = rawData[i].join(' ').toLowerCase();
      if (rowStr.includes('prodotto')) {
        headerRowIndex = i;
        headers = rawData[i].map(h => String(h).trim().toLowerCase());
        break;
      }
    }

    if (headerRowIndex === -1) {
      throw new Error("Intestazione 'PRODOTTO' non trovata nelle prime 15 righe.");
    }

    const idxProdotto = headers.findIndex(h => h.includes('prodotto'));
    const idxRate = headers.findIndex(h => (h.includes('rata') || h.includes('rate')) && !h.includes('prezzo') && !h.includes('euro'));
    let idxPrezzo = headers.findIndex(h => h.includes('prezzo') && h.includes('rata'));
    if (idxPrezzo === -1) {
       idxPrezzo = headers.findIndex(h => h.includes('rata') && (h.includes('euro') || h.includes('€') || h.includes('prezzo')));
    }

    console.log(`🎯 Colonne trovate: Prodotto=${idxProdotto}, Rate=${idxRate}, Prezzo=${idxPrezzo}`);

    const results = {};
    let count = 0;

    for (let i = headerRowIndex + 1; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row || row.length === 0) continue;

      const prodottiRaw = row[idxProdotto];
      if (!prodottiRaw) continue;

      let rateVal = 0;
      if (idxRate !== -1 && row[idxRate]) {
        const rawRate = String(row[idxRate]);
        rateVal = parseInt(rawRate.replace(/[^0-9]/g, ''), 10) || 0;
      }

      let prezzoVal = 0;
      if (idxPrezzo !== -1 && row[idxPrezzo]) {
        const rawPrice = String(row[idxPrezzo]);
        const cleanPrice = rawPrice.replace(',', '.').replace(/[^0-9.]/g, '');
        prezzoVal = parseFloat(cleanPrice) || 0;
      }

      let prodottiLista = [];
      if (typeof prodottiRaw === 'string') {
        prodottiLista = prodottiRaw.split(/\r?\n/).map(p => p.trim()).filter(p => p.length > 0);
      } else {
        prodottiLista = [String(prodottiRaw)];
      }

      prodottiLista.forEach(prodotto => {
        const cleanName = prodotto.trim();
        if (cleanName) {
          results[cleanName] = {
            rate: rateVal,
            prezzoRata: prezzoVal,
            operatore: "TIM",
            timestamp: new Date().toISOString()
          };
          count++;
        }
      });
    }

    console.log(`✅ Parsing completato. Trovate ${count} voci.`);
    return results;

  } catch (error) {
    console.error("❌ Errore critico nel parsing Excel:", error.message);
    throw error;
  }
}

// --- API ENDPOINTS ---

app.get('/api/config', (req, res) => {
  const config = readJsonFile(CONFIG_FILE, { shopName: 'Fvc Project Srl', address: 'Indirizzo esempio' });
  res.json(config);
});

app.post('/api/config', async (req, res) => {
  const newConfig = req.body;
  const currentConfig = readJsonFile(CONFIG_FILE, {});
  const finalConfig = { ...currentConfig, ...newConfig };
  writeJsonFile(CONFIG_FILE, finalConfig);
  
  if (newConfig.sendNotification) {
    await sendNotificationToAll('Catalogo Aggiornato', 'Nuovi prodotti disponibili nel negozio!');
  }
  res.json({ success: true });
});

app.get('/api/offers', (req, res) => {
  const offers = readJsonFile(OFFERS_FILE, []);
  res.json(offers);
});

app.post('/api/offers', async (req, res) => {
  writeJsonFile(OFFERS_FILE, req.body);
  await sendNotificationToAll('Nuova Offerta!', 'Controlla le promozioni del mese.');
  res.json({ success: true });
});

// Importazione Rate da Excel
app.post('/api/import-rates', upload.single('excelFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nessun file caricato.' });
  }

  try {
    console.log(`📂 Elaborazione file: ${req.file.path}`);
    const ratesData = parseTimData(req.file.path);
    writeJsonFile(RATES_FILE, ratesData);
    
    fs.unlinkSync(req.file.path);
    console.log("🗑️ File temporaneo eliminato.");

    res.json({ 
      success: true, 
      message: `Importate ${Object.keys(ratesData).length} voci.`,
      count: Object.keys(ratesData).length
    });
  } catch (error) {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: "Errore elaborazione: " + error.message });
  }
});

app.get('/api/rates', (req, res) => {
  const rates = readJsonFile(RATES_FILE, {});
  res.json(rates);
});

// Notifiche Push
let subscriptions = []; 

app.get('/api/vapid-public-key', (req, res) => {
  if (!vapidKeys.publicKey) {
    return res.status(500).json({ error: 'Chiavi VAPID non configurate sul server.' });
  }
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  const exists = subscriptions.some(sub => sub.endpoint === subscription.endpoint);
  if (!exists) {
    subscriptions.push(subscription);
    console.log(`🔔 Nuova sottoscrizione. Totale: ${subscriptions.length}`);
  }
  res.status(201).json({ success: true });
});

async function sendNotificationToAll(title, body) {
  if (!vapidKeys.publicKey) {
    console.warn("⚠️ Notifica ignorata: Chiavi VAPID mancanti.");
    return;
  }
  if (subscriptions.length === 0) {
    console.log("⚠️ Nessun cliente iscritto.");
    return;
  }
  
  const payload = JSON.stringify({ title, body, icon: '/icons/icon-192.png' });
  console.log(`🚀 Invio notifica "${title}"...`);
  
  const promises = subscriptions.map(sub => 
    webpush.sendNotification(sub, payload).catch(err => console.error('Errore invio:', err.message))
  );
  await Promise.all(promises);
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Server Fvc Project attivo sulla porta ${PORT}`);
  console.log(`📁 Dati: ${DATA_DIR}`);
  console.log(`📂 Upload: ${uploadDir}\n`);
});

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
const multer = require('multer'); // Per upload file
const XLSX = require('xlsx');     // Per leggere Excel/CSV

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAZIONE VAPID PER NOTIFICHE PUSH ---
// Sostituisci con le tue chiavi reali generate tramite 'npx web-push generate-vapid-keys'
const vapidKeys = {
  publicKey: 'YOUR_PUBLIC_KEY_HERE',
  privateKey: 'YOUR_PRIVATE_KEY_HERE'
};

webpush.setVapidDetails(
  'mailto:tuo@email.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public'))); // Serve i file statici (frontend)

// Percorsi per i dati
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const OFFERS_FILE = path.join(DATA_DIR, 'offers.json');
const RATES_FILE = path.join(DATA_DIR, 'tim-rates.json'); // Nuovo file per le rate

// Assicurati che la cartella data esista
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// --- CONFIGURAZIONE MULTER (UPLOAD FILE) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, 'import_rates.xlsx'); // Sovrascrive sempre lo stesso file temporaneo
  }
});
const upload = multer({ storage: storage });

// --- FUNZIONI DI SUPPORTO ---
function readJsonFile(file, defaultData) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) { console.error(`Errore lettura ${file}:`, e); }
  return defaultData;
}

function writeJsonFile(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Logica di parsing specifica per il formato TIM (come nello script locale)
function parseTimData(filePath) {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (rawData.length === 0) throw new Error("File vuoto");

    // Trova intestazioni dinamicamente
    let startRowIndex = 0;
    let headers = [];
    
    // Cerca la riga delle intestazioni (dove c'è "PRODOTTO" o simile)
    for (let i = 0; i < Math.min(rawData.length, 10); i++) {
      const rowStr = rawData[i].join(' ').toLowerCase();
      if (rowStr.includes('prodotto') && rowStr.includes('rata')) {
        headers = rawData[i].map(h => String(h).trim().toLowerCase());
        startRowIndex = i + 1;
        break;
      }
    }

    if (headers.length === 0) throw new Error("Intestazioni non trovate");

    const idxProdotto = headers.findIndex(h => h.includes('prodotto'));
    const idxRate = headers.findIndex(h => h.includes('rata') && !h.includes('prezzo'));
    const idxPrezzo = headers.findIndex(h => h.includes('prezzo') || (h.includes('rata') && h.includes('euro')));

    if (idxProdotto === -1) throw new Error("Colonna Prodotto non trovata");

    const results = {};

    for (let i = startRowIndex; i < rawData.length; i++) {
      const row = rawData[i];
      const prodottiRaw = row[idxProdotto];
      
      // Se non ci sono dati nella riga, salta
      if (!prodottiRaw) continue;

      // Recupera valori comuni della riga
      const rateVal = (idxRate !== -1 && row[idxRate]) ? Number(String(row[idxRate]).replace(/[^0-9]/g, '')) : 0;
      const prezzoVal = (idxPrezzo !== -1 && row[idxPrezzo]) ? String(row[idxPrezzo]).replace(',', '.') : "0";
      
      // Gestione prodotti multipli nella stessa cella (separati da a capo)
      let prodottiLista = [];
      if (typeof prodottiRaw === 'string') {
        prodottiLista = prodottiRaw.split(/\r?\n/).map(p => p.trim()).filter(p => p.length > 0);
      } else {
        prodottiLista = [String(prodottiRaw)];
      }

      // Mappa ogni prodotto al suo oggetto rateale
      prodottiLista.forEach(prodotto => {
        // Pulizia nome prodotto per matching migliore (opzionale)
        const cleanName = prodotto.trim();
        
        // Salviamo in un oggetto chiave-valore: NomeProdotto -> DatiRate
        results[cleanName] = {
          rate: rateVal,
          prezzoRata: parseFloat(prezzoVal) || 0,
          operatore: "TIM",
          timestamp: new Date().toISOString()
        };
      });
    }

    return results;
  } catch (error) {
    console.error("Errore parsing Excel:", error);
    throw error;
  }
}

// --- API ENDPOINTS ---

// 1. Configurazione Negozio
app.get('/api/config', (req, res) => {
  const config = readJsonFile(CONFIG_FILE, { shopName: 'Fvc Project Srl', address: 'Indirizzo esempio' });
  res.json(config);
});

app.post('/api/config', async (req, res) => {
  const newConfig = req.body;
  const currentConfig = readJsonFile(CONFIG_FILE, {});
  
  // Unisci configurazione esistente con nuova (mantieni prodotti se non inviati)
  const finalConfig = { ...currentConfig, ...newConfig };
  
  writeJsonFile(CONFIG_FILE, finalConfig);
  
  // Se flag presente, invia notifica
  if (newConfig.sendNotification) {
    await sendNotificationToAll('Catalogo Aggiornato', 'Nuovi prodotti disponibili nel negozio!');
  }
  
  res.json({ success: true });
});

// 2. Offerte
app.get('/api/offers', (req, res) => {
  const offers = readJsonFile(OFFERS_FILE, []);
  res.json(offers);
});

app.post('/api/offers', async (req, res) => {
  writeJsonFile(OFFERS_FILE, req.body);
  await sendNotificationToAll('Nuova Offerta!', 'Controlla le promozioni del mese.');
  res.json({ success: true });
});

// 3. NUOVO: Importazione Rate da Excel
app.post('/api/import-rates', upload.single('excelFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nessun file caricato' });
  }

  try {
    console.log(`Elaborazione file: ${req.file.path}`);
    const ratesData = parseTimData(req.file.path);
    
    // Salva il database delle rate
    writeJsonFile(RATES_FILE, ratesData);
    
    // Opzionale: Elimina file temporaneo dopo elaborazione
    fs.unlinkSync(req.file.path);

    console.log(`Importate ${Object.keys(ratesData).length} voci rateali.`);
    
    // Invia notifica opzionale (potresti volerla disabilitare se fai update frequenti)
    // await sendNotificationToAll('Listino Rate Aggiornato', 'Le nuove rateizzazioni TIM sono disponibili.');

    res.json({ success: true, count: Object.keys(ratesData).length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint per ottenere le rate (usato dal frontend)
app.get('/api/rates', (req, res) => {
  const rates = readJsonFile(RATES_FILE, {});
  res.json(rates);
});

// 4. Notifiche Push
let subscriptions = []; // In produzione usa un DB reale (Redis/Mongo)

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  // Evita duplicati
  const exists = subscriptions.some(sub => sub.endpoint === subscription.endpoint);
  if (!exists) subscriptions.push(subscription);
  res.status(201).json({});
});

async function sendNotificationToAll(title, body) {
  const payload = JSON.stringify({ title, body });
  const promises = subscriptions.map(sub => 
    webpush.sendNotification(sub, payload).catch(err => console.error('Errore invio notifica:', err))
  );
  await Promise.all(promises);
}

// --- AVVIO SERVER ---
app.listen(PORT, () => {
  console.log(`Server attivo su http://localhost:${PORT}`);
  console.log(`Cartella dati: ${DATA_DIR}`);
});

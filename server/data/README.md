# Fvc Project Srl — Server

Questo server fa due cose:
1. Serve la app (la cartella sopra a questa, con `index.html`, ecc.)
2. Manda una notifica push a tutti i clienti iscritti ogni volta che aggiungi una nuova offerta

I dati che devono restare nel tempo (chi è iscritto, quali offerte sono già
state notificate, le chiavi di sicurezza) sono salvati su **Upstash Redis**,
un database gratuito che — a differenza del disco di Render — non si
cancella mai a ogni riavvio o nuovo deploy.

## Passo 1 — Crea il database gratuito su Upstash

1. Vai su **upstash.com** → "Sign up" (gratis, nessuna carta richiesta)
2. Nella dashboard, crea un nuovo database → tipo **Redis**
3. Scegli una regione vicina a te (es. Europa) e crea
4. Nella pagina del database, sezione **REST API**, copia i due valori:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

## Passo 2 — Collega queste chiavi a Render

1. Vai sul tuo servizio su Render → tab **"Environment"**
2. Aggiungi due variabili d'ambiente:
   - `UPSTASH_REDIS_REST_URL` → incolla il valore copiato prima
   - `UPSTASH_REDIS_REST_TOKEN` → incolla il valore copiato prima
3. Salva: Render rifà il deploy da solo con le nuove variabili attive

Da questo momento, iscrizioni alle notifiche e chiavi di sicurezza restano
salvate per sempre, anche se il servizio si riavvia o va in "sleep".

## Passo 3 — Imposta la password del pannello di gestione offerte

1. Su Render → tab **"Environment"** → aggiungi una terza variabile:
   - `ADMIN_PASSWORD` → scegli tu una password (solo per te, non condividerla)
2. Salva, aspetta il nuovo deploy
3. Apri `https://tuo-indirizzo.onrender.com/admin.html`, inserisci la password
4. Da lì puoi aggiungere, modificare ed eliminare le offerte con un form —
   ogni offerta **nuova** creata dal pannello manda la notifica push in
   automatico a tutti gli iscritti; modificare o eliminare un'offerta
   esistente non genera notifiche.

Il file `server/data/offers.json` resta solo come "punto di partenza": viene
letto una sola volta, al primissimo avvio in assoluto, per popolare Upstash
con le 3 offerte di esempio. Da quel momento in poi tutta la gestione passa
dal pannello `admin.html`, non serve più modificare quel file.

## Avvio in locale (per provare sul tuo PC)

```
cd server
npm install
```

Poi crea un file `.env` in questa cartella (solo in locale, non va mai
caricato su GitHub) con questo contenuto:

```
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

e avvia con:

```
npm start
```

## Come aggiungere un'offerta (ora dal pannello grafico)

Non serve più modificare `offers.json` a mano: apri
`https://tuo-indirizzo.onrender.com/admin.html`, inserisci la password che hai
impostato in `ADMIN_PASSWORD` e usa il form. Ogni offerta nuova che crei da lì
notifica in automatico tutti i clienti iscritti.

## Dove metterlo online

Serve un hosting che faccia girare Node.js in continuo. Render.com funziona
bene anche sul piano gratuito (si "addormenta" dopo 15 minuti di inattività
e si risveglia in circa un minuto — va benissimo per i test).

## Riepilogo dei dati

- `data/offers.json` — le offerte mostrate nella app (lo modifichi tu su GitHub)
- Iscrizioni, offerte già notificate, chiavi di sicurezza — su Upstash Redis,
  permanenti

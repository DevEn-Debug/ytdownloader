<p align="center">
  <img src="public/logo.svg" alt="YT Downloader" width="96" height="96">
</p>

<h1 align="center">YT Downloader</h1>

<p align="center">
  Una coda di download per YouTube, semplice e veloce.<br>
  Incolli i link, premi <b>Avvia coda</b> e i video si scaricano uno per volta alla qualità massima.
</p>

<p align="center">
  <a href="../../releases/latest"><img alt="Ultima release" src="https://img.shields.io/github/v/release/DevEn-Debug/ytdownloader?color=ff4a2e&label=release"></a>
  <img alt="Piattaforma" src="https://img.shields.io/badge/piattaforma-Windows-101113">
  <img alt="Licenza" src="https://img.shields.io/badge/licenza-MIT-101113">
</p>

<p align="center">
  <img src="docs/screenshot.png" alt="Screenshot di YT Downloader con una coda di video" width="720">
</p>

## Cosa fa

- **Coda di download.** Aggiungi quanti link vuoi, poi avvia: li scarica uno alla volta, senza che tu debba stare lì.
- **Qualità massima.** Usa [yt-dlp](https://github.com/yt-dlp/yt-dlp) con `bestvideo+bestaudio/best` e unisce video e audio in un unico **MP4** con [ffmpeg](https://ffmpeg.org).
- **Anteprima di ogni video.** Copertina, titolo e durata compaiono appena incolli il link.
- **Cartella di destinazione globale.** La scegli una volta e vale per tutti i video che aggiungi da quel momento. Se la cambi, i video già in coda restano dove erano e quelli nuovi vanno nella nuova cartella.
- **Avanzamento in tempo reale.** Percentuale, velocità e tempo rimanente per il video in corso.
- **Pausa, annulla, riprova, rimuovi.** La coda viene salvata: se chiudi l'app a metà, riparte da dove era rimasta.
- **Si installa da solo i pezzi che mancano.** All'avvio controlla `yt-dlp` e `ffmpeg` e, se non ci sono, li installa con `winget`.

## Installazione

### Opzione 1: file `.exe` (consigliata)

1. Vai alla pagina delle [**Releases**](../../releases/latest) e scarica `YT-Downloader.exe`.
2. Fai doppio clic. Si apre una finestra con l'app e una console che mostra i controlli iniziali; a controlli finiti la console si riduce a icona nella barra delle applicazioni.
3. Al primo avvio, se mancano `yt-dlp` o `ffmpeg`, li installa da solo (serve `winget`, già presente su Windows 10/11 aggiornati). Può chiedere conferma per l'installazione.

Per chiudere l'app, chiudi la finestra della console ridotta a icona (clic destro sull'icona nella barra delle applicazioni, poi *Chiudi finestra*).

> **Windows mostra "Windows ha protetto il PC"?** L'eseguibile non è firmato digitalmente. Clicca su **Maggiori informazioni** e poi su **Esegui comunque**.

I tuoi dati stanno in `%APPDATA%\YT Downloader` (coda e impostazioni). I video, se non scegli altro, vanno in `Video\YT Downloader`.

### Opzione 2: dal codice sorgente

Servono [Node.js](https://nodejs.org) 18 o successivo, [Yarn](https://yarnpkg.com) e Windows (per l'installazione automatica di `yt-dlp` e `ffmpeg`).

```bash
git clone https://github.com/DevEn-Debug/ytdownloader.git
cd ytdownloader
yarn dev
```

L'app si apre da sola. Non ci sono dipendenze da installare per usarla: `yarn install` serve solo per creare l'`.exe`.

## Come si usa

1. Controlla (o cambia) la cartella in **Salva in**: con **Sfoglia** ne scegli un'altra, con **Apri** apri quella attuale in Esplora file.
2. Incolla il link di un video e premi **Invio** (o **Aggiungi**). Puoi incollare anche più link insieme.
3. Premi **Avvia coda**. Con **Pausa** la coda si ferma dopo il video in corso.
4. Su ogni video puoi **Annullare**, **Riprovare** o **Rimuovere**. **Pulisci completati** svuota dalla lista quelli finiti.

Se incolli il link di un video dentro una playlist, viene scaricato solo quel video.

## Creare l'`.exe`

```bash
yarn install
yarn build
```

Il risultato è `dist/YT-Downloader.exe`: un unico file (circa 90 MB) che contiene Node.js, il server e l'interfaccia, costruito con le [Single Executable Applications](https://nodejs.org/api/single-executable-applications.html) di Node. Il lavoro lo fa `scripts/build-exe.js`: unisce il codice con `esbuild`, incorpora i file della pagina, imposta l'icona e inietta tutto in una copia di `node.exe`. Serve Windows e Node.js 22 o successivo.

## Impostazioni avanzate

Variabili d'ambiente, tutte facoltative:

| Variabile | Cosa fa | Predefinito |
| --- | --- | --- |
| `PORT` | Porta del server locale | `3000` |
| `DOWNLOAD_DIR` | Cartella dei video alla prima esecuzione | `downloads/` (sorgente) o `Video\YT Downloader` (`.exe`) |
| `DATA_DIR` | Dove salvare `queue.json` e `settings.json` | cartella del progetto (sorgente) o `%APPDATA%\YT Downloader` (`.exe`) |
| `NO_OPEN` | Se impostata, non apre la finestra all'avvio | |

Il server ascolta solo su `127.0.0.1`: non è raggiungibile da altri computer.

## Struttura

```
server.js            server HTTP, coda di download e integrazione con yt-dlp
lib/ensure-deps.js   controlla e installa yt-dlp e ffmpeg con winget
public/              interfaccia (HTML, CSS, JavaScript, logo, icone)
scripts/             creazione dell'icona e dell'.exe
```

## Uso responsabile

Scarica solo contenuti che ti appartengono, che hanno una licenza che lo permette o che hai il diritto di salvare. Il download di video può violare i termini di servizio di YouTube o il diritto d'autore, a seconda dei casi e del Paese: la responsabilità dell'uso è tua.

## Crediti

- [yt-dlp](https://github.com/yt-dlp/yt-dlp), che fa tutto il lavoro di download.
- [FFmpeg](https://ffmpeg.org), per unire video e audio.
- [Lucide](https://lucide.dev), per le icone (licenza ISC).

## Licenza

[MIT](LICENSE)

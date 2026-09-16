// Implémentation du protocole STK500v1 (bootloader Optiboot / bootloader Arduino classique)
// au-dessus de la Web Serial API du navigateur.
//
// Adapté de l'algorithme du paquet npm "stk500" (js-stk500v1, MIT) et de la séquence de
// réinitialisation utilisée par avrgirl-arduino (MIT) — réécrit ici sans dépendance Node
// pour tourner directement dans une page d'extension Chrome.

const STK = {
  Cmnd_STK_GET_SYNC: 0x30,
  Cmnd_STK_SET_DEVICE: 0x42,
  Cmnd_STK_ENTER_PROGMODE: 0x50,
  Cmnd_STK_LEAVE_PROGMODE: 0x51,
  Cmnd_STK_LOAD_ADDRESS: 0x55,
  Cmnd_STK_PROG_PAGE: 0x64,
  Cmnd_STK_READ_SIGN: 0x75,
  Sync_CRC_EOP: 0x20,
  Resp_STK_INSYNC: 0x14,
  Resp_STK_OK: 0x10,
  Resp_STK_NOSYNC: 0x15
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Petite couche d'E/S bufferisée au-dessus d'un reader Web Serial : un unique appel
// read() tourne en continu en arrière-plan ("pump"), et readBytes() consulte simplement
// ce qui s'est accumulé, avec un délai d'attente. Important : la Web Serial API n'autorise
// qu'un seul appel read() en attente à la fois sur un même reader — relancer read() à
// chaque tentative (comme le faisait la version précédente) empile des lectures jamais
// résolues et peut geler l'onglet au lieu d'échouer proprement.
class BufferedSerialReader {
  constructor(reader) {
    this.reader = reader;
    this.buffer = new Uint8Array(0);
    this.stopped = false;
    this.pumpError = null;
    this._pumpPromise = this._pump();
  }

  async _pump() {
    try {
      while (!this.stopped) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) this._append(value);
      }
    } catch (e) {
      if (!this.stopped) this.pumpError = e;
    }
  }

  _append(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }

  async readBytes(n, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.buffer.length < n) {
      if (this.pumpError) throw this.pumpError;
      if (Date.now() >= deadline) {
        throw new Error("Délai dépassé en attendant une réponse de la carte");
      }
      await sleep(5);
    }
    const out = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return out;
  }

  // À appeler avant de relâcher le reader : annule la lecture en attente (sinon
  // releaseLock() échoue tant qu'un read() n'est pas résolu) et arrête le pump.
  async stop() {
    this.stopped = true;
    try { await this.reader.cancel(); } catch (e) {}
    try { await this._pumpPromise; } catch (e) {}
  }
}

class STK500Flasher {
  // port: un SerialPort déjà ouvert (navigator.serial), à la vitesse du bootloader (baud).
  constructor(port, onLog) {
    this.port = port;
    this.onLog = onLog || (() => {});
    this.writer = null;
    this.bufReader = null;
  }

  async _write(bytes) {
    await this.writer.write(new Uint8Array(bytes));
  }

  // Envoie une commande (tableau d'octets, EOP ajouté automatiquement) et vérifie la
  // réponse. expected: tableau d'octets attendu APRÈS l'INSYNC initial, ou null pour ne
  // renvoyer que les octets bruts lus (utilisé pour lire la signature par ex.)
  async _sendCommand(cmdBytes, expectedAfterSync, extraReadLength, timeoutMs) {
    const timeout = timeoutMs || 1000;
    const full = cmdBytes.concat([STK.Sync_CRC_EOP]);
    await this._write(full);

    const readLen = 1 + (expectedAfterSync ? expectedAfterSync.length : extraReadLength) + 1;
    const resp = await this.bufReader.readBytes(readLen, timeout);

    if (resp[0] !== STK.Resp_STK_INSYNC) {
      throw new Error("Pas de synchronisation (INSYNC attendu, reçu 0x" + resp[0].toString(16) + ")");
    }
    if (resp[resp.length - 1] !== STK.Resp_STK_OK) {
      throw new Error("La carte a refusé la commande (pas de STK_OK final)");
    }
    const middle = resp.slice(1, resp.length - 1);
    if (expectedAfterSync && !bytesEqual(middle, expectedAfterSync)) {
      throw new Error("Réponse inattendue de la carte");
    }
    return middle;
  }

  async _sync(attempts, timeoutMs) {
    let lastErr;
    let anyDataSeen = false;
    for (let i = 0; i < attempts; i++) {
      try {
        await this._sendCommand([STK.Cmnd_STK_GET_SYNC], [], 0, timeoutMs);
        return;
      } catch (e) {
        lastErr = e;
        if (this.bufReader.buffer.length > 0) {
          anyDataSeen = true;
          const hex = Array.from(this.bufReader.buffer).map(b => b.toString(16).padStart(2, "0")).join(" ");
          this.onLog("  [diag] tentative " + (i + 1) + " : " + this.bufReader.buffer.length + " octet(s) reçu(s) : " + hex);
        }
        // On vide le buffer de lecture au cas où des octets parasites traînent.
        this.bufReader.buffer = new Uint8Array(0);
        await sleep(15);
      }
    }
    const diag = anyDataSeen
      ? ""
      : " — [diag] AUCUNE donnée reçue sur le port pendant toute la boucle (" + attempts + " tentatives).";
    throw new Error("Impossible de synchroniser avec le bootloader : " + (lastErr ? lastErr.message : "") + diag);
  }

  async _resetBoard() {
    this.onLog("Réinitialisation de la carte (DTR/RTS)...");
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await sleep(250);
    await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    await sleep(50);
  }

  // hexBytes: Uint8Array (image mémoire flash complète, issue de parseIntelHex).
  // board: profil de boards.js ({ pageSize, signature, ... }).
  async flash(hexBytes, board) {
    this.writer = this.port.writable.getWriter();
    this.bufReader = new BufferedSerialReader(this.port.readable.getReader());

    try {
      await this._resetBoard();

      this.onLog("Synchronisation avec le bootloader...");
      // Boucle rapide : mieux vaut beaucoup de tentatives courtes qu'une seule
      // tentative qui monopolise toute la fenêtre d'ouverture du bootloader.
      await this._sync(35, 120);

      this.onLog("Vérification de la puce...");
      const sig = await this._sendCommand([STK.Cmnd_STK_READ_SIGN], null, 3, 1000);
      if (!bytesEqual(Array.from(sig), board.signature)) {
        const got = Array.from(sig).map(b => b.toString(16).padStart(2, "0")).join(" ");
        const expected = board.signature.map(b => b.toString(16).padStart(2, "0")).join(" ");
        throw new Error(
          "Signature inattendue (reçu " + got + ", attendu " + expected + "). " +
          "Vérifie que la carte sélectionnée correspond bien à la carte branchée."
        );
      }

      this.onLog("Configuration du programmeur...");
      const pageHigh = (board.pageSize >> 8) & 0xff;
      const pageLow = board.pageSize & 0xff;
      const deviceParams = [
        0, 0, 0, 0, 0, 0, 0, 0,
        pageHigh, pageLow,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0
      ];
      await this._sendCommand([STK.Cmnd_STK_SET_DEVICE].concat(deviceParams), [], 0, 1000);

      this.onLog("Entrée en mode programmation...");
      await this._sendCommand([STK.Cmnd_STK_ENTER_PROGMODE], [], 0, 1000);

      const pageSize = board.pageSize;
      const totalPages = Math.ceil(hexBytes.length / pageSize);
      this.onLog("Écriture de la mémoire flash (" + hexBytes.length + " octets, " + totalPages + " pages)...");

      for (let pageAddr = 0, pageNum = 1; pageAddr < hexBytes.length; pageAddr += pageSize, pageNum++) {
        const wordAddr = pageAddr >> 1;
        await this._sendCommand(
          [STK.Cmnd_STK_LOAD_ADDRESS, wordAddr & 0xff, (wordAddr >> 8) & 0xff],
          [], 0, 1000
        );

        const end = Math.min(pageAddr + pageSize, hexBytes.length);
        const chunk = hexBytes.slice(pageAddr, end);
        const lenHigh = (chunk.length >> 8) & 0xff;
        const lenLow = chunk.length & 0xff;
        const progCmd = [STK.Cmnd_STK_PROG_PAGE, lenHigh, lenLow, 0x46].concat(Array.from(chunk));
        await this._sendCommand(progCmd, [], 0, 2000);

        this.onLog("Page " + pageNum + "/" + totalPages + " écrite");
        await sleep(4);
      }

      this.onLog("Sortie du mode programmation...");
      await this._sendCommand([STK.Cmnd_STK_LEAVE_PROGMODE], [], 0, 1000);

      this.onLog("Téléversement terminé ✅");
    } finally {
      try { await this.bufReader.stop(); } catch (e) {}
      try { this.writer.releaseLock(); } catch (e) {}
    }
  }
}
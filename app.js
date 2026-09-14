const DEFAULT_SKETCH = `void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("LED allumée");
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("LED éteinte");
  delay(500);
}
`;

const boardSelect = document.getElementById("board");
const backendUrlInput = document.getElementById("backendUrl");
const connectBtn = document.getElementById("connectBtn");
const uploadBtn = document.getElementById("uploadBtn");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const logEl = document.getElementById("log");
const monitorOutput = document.getElementById("monitorOutput");
const monitorBaudSelect = document.getElementById("monitorBaud");
const monitorToggleBtn = document.getElementById("monitorToggle");
const monitorInput = document.getElementById("monitorInput");
const monitorSendBtn = document.getElementById("monitorSend");
const unsupportedBanner = document.getElementById("unsupportedBanner");

let port = null;
let portBaud = null;
let monitorActive = false;
let currentMonitorReader = null;

// --- Détection Web Serial ---
const serialSupported = "serial" in navigator;
if (!serialSupported) {
  unsupportedBanner.hidden = false;
  connectBtn.disabled = true;
}

// --- Éditeur ---
for (const key in BOARDS) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = BOARDS[key].label;
  boardSelect.appendChild(opt);
}

const editor = CodeMirror.fromTextArea(document.getElementById("code"), {
  mode: "text/x-c++src",
  theme: "dracula",
  lineNumbers: true,
  matchBrackets: true,
  autoCloseBrackets: true,
  indentUnit: 2,
  tabSize: 2,
  smartIndent: true
});
editor.setValue(DEFAULT_SKETCH);

// --- Persistance des réglages (localStorage : simple page web, pas d'extension) ---
try {
  const savedBackend = localStorage.getItem("arduinoIde.backendUrl");
  const savedBoard = localStorage.getItem("arduinoIde.board");
  const savedSketch = localStorage.getItem("arduinoIde.sketch");
  if (savedBackend) backendUrlInput.value = savedBackend;
  if (savedBoard && BOARDS[savedBoard]) boardSelect.value = savedBoard;
  if (savedSketch) editor.setValue(savedSketch);
} catch (e) {
  // localStorage indisponible (navigation privée très restrictive) : tant pis, pas bloquant
}
backendUrlInput.addEventListener("change", () => {
  try { localStorage.setItem("arduinoIde.backendUrl", backendUrlInput.value.trim()); } catch (e) {}
});
boardSelect.addEventListener("change", () => {
  try { localStorage.setItem("arduinoIde.board", boardSelect.value); } catch (e) {}
});
editor.on("blur", () => {
  try { localStorage.setItem("arduinoIde.sketch", editor.getValue()); } catch (e) {}
});

// --- Logs ---
function logLine(kind, text) {
  const div = document.createElement("div");
  if (kind === "error") div.className = "line-error";
  else if (kind === "ok") div.className = "line-ok";
  else if (kind === "warn") div.className = "line-warn";
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}
function clearLog() {
  logEl.innerHTML = "";
}

function setStatus(kind, text) {
  statusDot.className = "dot" + (kind ? " " + kind : "");
  statusText.textContent = text;
}
function setBusy(busy) {
  connectBtn.disabled = busy || !serialSupported;
  uploadBtn.disabled = busy || !port;
  monitorToggleBtn.disabled = busy;
  if (busy) setStatus("busy", "Occupé…");
}

// --- Onglets Console / Moniteur ---
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

// --- Connexion au port série ---
connectBtn.addEventListener("click", async () => {
  if (!serialSupported) {
    logLine("error", "Web Serial API indisponible dans ce navigateur.");
    return;
  }
  try {
    port = await navigator.serial.requestPort();
    uploadBtn.disabled = false;
    setStatus("connected", "Port sélectionné");
    logLine("ok", "Port série sélectionné. Prêt à téléverser.");
  } catch (e) {
    logLine("warn", "Sélection de port annulée.");
  }
});

async function closePortIfOpen() {
  if (monitorActive) {
    await stopMonitor();
    return;
  }
  if (portBaud !== null) {
    try { await port.close(); } catch (e) {}
    portBaud = null;
  }
}

// --- Compilation + téléversement ---
uploadBtn.addEventListener("click", async () => {
  if (!port) {
    logLine("error", "Connecte d'abord un port série.");
    return;
  }
  const boardKey = boardSelect.value;
  const board = BOARDS[boardKey];
  const backendUrl = backendUrlInput.value.trim().replace(/\/+$/, "");
  if (!backendUrl) {
    logLine("error", "Renseigne l'URL du serveur de compilation dans la barre du haut.");
    return;
  }

  setBusy(true);
  clearLog();
  logLine("warn", "Compilation pour " + board.label + " (" + board.fqbn + ")…");

  try {
    const res = await fetch(backendUrl + "/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sketch: editor.getValue(), fqbn: board.fqbn })
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.error) {
      logLine("error", "Échec de la compilation.");
      if (data.stderr) logLine("error", data.stderr);
      else if (data.error) logLine("error", data.error);
      else logLine("error", "HTTP " + res.status);
      return;
    }
    if (data.stdout) logLine("", data.stdout);
    logLine("ok", "Compilation réussie.");

    const flashBytes = parseIntelHex(data.hex);
    logLine("warn", "Image binaire : " + flashBytes.length + " octets. Connexion à " + board.baud + " bauds…");

    await closePortIfOpen();
    await port.open({ baudRate: board.baud });
    portBaud = board.baud;

    const flasher = new STK500Flasher(port, (msg) => logLine("", msg));
    await flasher.flash(flashBytes, board);

    logLine("ok", "✅ Téléversé sur " + board.label + ".");
    setStatus("connected", "Téléversement réussi");
  } catch (e) {
    logLine("error", "Erreur : " + e.message);
    setStatus("error", "Erreur");
  } finally {
    try { await port.close(); } catch (e) {}
    portBaud = null;
    setBusy(false);
  }
});

// --- Moniteur série ---
async function monitorReaderLoop() {
  const reader = port.readable.getReader();
  currentMonitorReader = reader;
  const decoder = new TextDecoder();
  try {
    while (monitorActive) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) {
        monitorOutput.textContent += decoder.decode(value, { stream: true });
        monitorOutput.scrollTop = monitorOutput.scrollHeight;
      }
    }
  } catch (e) {
    if (monitorActive) logLine("error", "Moniteur série : " + e.message);
  } finally {
    try { reader.releaseLock(); } catch (e) {}
  }
}

async function stopMonitor() {
  monitorActive = false;
  if (currentMonitorReader) {
    try { await currentMonitorReader.cancel(); } catch (e) {}
    currentMonitorReader = null;
  }
  if (portBaud !== null) {
    try { await port.close(); } catch (e) {}
    portBaud = null;
  }
  monitorToggleBtn.textContent = "Ouvrir le moniteur";
}

monitorToggleBtn.addEventListener("click", async () => {
  if (monitorActive) {
    await stopMonitor();
    return;
  }
  if (!port) {
    logLine("error", "Connecte d'abord un port série.");
    return;
  }
  const baud = parseInt(monitorBaudSelect.value, 10);
  await closePortIfOpen();
  try {
    await port.open({ baudRate: baud });
    portBaud = baud;
    monitorActive = true;
    monitorOutput.textContent = "";
    monitorToggleBtn.textContent = "Fermer le moniteur";
    monitorReaderLoop();
  } catch (e) {
    logLine("error", "Impossible d'ouvrir le moniteur : " + e.message);
  }
});

async function sendMonitorLine() {
  if (!monitorActive) return;
  const text = monitorInput.value;
  if (!text) return;
  const writer = port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(text + "\n"));
  } finally {
    writer.releaseLock();
  }
  monitorInput.value = "";
}
monitorSendBtn.addEventListener("click", sendMonitorLine);
monitorInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMonitorLine();
});

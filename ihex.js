// Parseur Intel HEX minimal (types 00 = data, 01 = EOF, 04 = extended linear address).
// Suffisant pour les .hex produits par arduino-cli pour les puces AVR 8 bits classiques
// (flash <= 64 Ko, donc l'adresse étendue linéaire n'est normalement pas utilisée,
// mais on la gère quand même par prudence).
function parseIntelHex(hexText) {
  const lines = hexText.split(/\r?\n/).filter(l => l.trim().length > 0);
  let bytes = []; // {addr, value}
  let upperAddr = 0;

  for (const line of lines) {
    if (!line.startsWith(":")) continue;
    const byteCount = parseInt(line.substr(1, 2), 16);
    const address = parseInt(line.substr(3, 4), 16);
    const recordType = parseInt(line.substr(7, 2), 16);
    const dataStart = 9;

    if (recordType === 0x00) {
      for (let i = 0; i < byteCount; i++) {
        const byteHex = line.substr(dataStart + i * 2, 2);
        const value = parseInt(byteHex, 16);
        const fullAddr = upperAddr + address + i;
        bytes.push({ addr: fullAddr, value });
      }
    } else if (recordType === 0x01) {
      break; // EOF
    } else if (recordType === 0x04) {
      const upperHex = line.substr(dataStart, 4);
      upperAddr = parseInt(upperHex, 16) << 16;
    }
    // types 02/03/05 ignorés (segment/start address), pas utilisés par avr-gcc moderne
  }

  if (bytes.length === 0) {
    throw new Error("Fichier .hex vide ou illisible");
  }

  const maxAddr = bytes.reduce((m, b) => Math.max(m, b.addr), 0);
  const flat = new Uint8Array(maxAddr + 1).fill(0xFF);
  for (const b of bytes) {
    flat[b.addr] = b.value;
  }
  return flat;
}

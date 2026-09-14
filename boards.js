// Profils de cartes supportées par le flasheur STK500v1 (bootloader Optiboot / ancien bootloader).
// Note : l'Arduino Mega2560 utilise le protocole STK500v2, pas encore supporté ici.
const BOARDS = {
  "uno": {
    label: "Arduino Uno (ATmega328P)",
    fqbn: "arduino:avr:uno",
    baud: 115200,
    pageSize: 128,
    signature: [0x1E, 0x95, 0x0F]
  },
  "nano328": {
    label: "Arduino Nano (ATmega328P, bootloader récent)",
    fqbn: "arduino:avr:nano:cpu=atmega328",
    baud: 115200,
    pageSize: 128,
    signature: [0x1E, 0x95, 0x0F]
  },
  "nano328old": {
    label: "Arduino Nano (ATmega328P, ancien bootloader)",
    fqbn: "arduino:avr:nano:cpu=atmega328old",
    baud: 57600,
    pageSize: 128,
    signature: [0x1E, 0x95, 0x0F]
  },
  "nano168": {
    label: "Arduino Nano (ATmega168)",
    fqbn: "arduino:avr:nano:cpu=atmega168",
    baud: 19200,
    pageSize: 128,
    signature: [0x1E, 0x94, 0x06]
  }
};

const DEFAULT_BOARD = "uno";

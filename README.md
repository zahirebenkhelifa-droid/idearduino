# Arduino Mini-IDE (Chromebook)

Pour écrire, compiler et téléverser des sketches Arduino directement depuis un Chromebook,
sans agent natif à installer — via la **Web Serial API**. Deux façons de le livrer :

- **`webapp/`** — une simple page web (recommandé si le mode développeur est verrouillé sur
  vos Chromebooks, ce qui est le cas sur la plupart des flottes scolaires gérées). Web Serial
  fonctionne depuis n'importe quel site en HTTPS, sans rien installer — c'est le même
  principe que tes autres outils sur GitHub Pages (parapheur, sondage-web3forms). Il suffit
  d'aller sur l'URL.
- **`extension/`** — la version extension Chrome (Manifest V3), utile si tu gères des postes
  où le mode développeur est disponible, ou si tu la publies plus tard sur le Chrome Web
  Store avec liste blanche côté admin.

Les deux partagent exactement le même moteur (éditeur, parseur Intel HEX, flasheur
STK500v1) — seule la façon de le distribuer change.

⚠️ **Un point reste à vérifier avant de compter dessus** : même une page web classique peut
être bloquée par la politique d'entreprise `DefaultSerialGuardSetting` si l'administrateur a
désactivé Web Serial globalement (indépendamment du mode développeur). Vérifie-la dans
`chrome://policy` avant de construire toute une séance dessus — voir plus bas.

## Comment ça marche

```
[Extension Chrome]                         [Ton serveur]
 éditeur + Web Serial   ──POST /compile──▶  arduino-cli compile
        ▲                                          │
        └──────────── .hex (texte) ◀───────────────┘
        │
        ▼
 flash STK500v1 (JS, over Web Serial)
        │
        ▼
   carte Arduino (USB)
```

Deux parties, dans ce dossier :

- **`extension/`** — l'extension Chrome : éditeur de code (CodeMirror), sélection de carte,
  moniteur série, et le flasheur STK500v1 écrit en JS pur (aucune dépendance Node).
- **`backend/`** — un petit serveur Express qui appelle `arduino-cli compile` et renvoie le
  `.hex`. C'est la seule partie qui a besoin d'un vrai environnement (le compilateur AVR ne
  tourne pas dans un navigateur).

## Option site web (aucune installation, aucun mode développeur)

1. Pousse le contenu de `webapp/` sur GitHub Pages (même flux que tes autres outils :
   nouveau repo, glisser les fichiers, Settings → Pages → déployer depuis la branche).
   GitHub Pages sert en HTTPS par défaut, ce qu'exige Web Serial.
2. Ouvre l'URL `https://<toncompte>.github.io/<repo>/` sur le Chromebook.
3. En haut, renseigne l'URL de ton serveur de compilation (voir plus bas).
4. Si le bandeau orange "Web Serial API indisponible" apparaît en haut de la page, c'est que
   `DefaultSerialGuardSetting` bloque l'accès — direction `chrome://policy` pour confirmer,
   puis la même démarche institutionnelle que pour le mode développeur (demande au référent
   numérique / DSI).

C'est la voie la plus simple : rien à charger, rien à faire whitelister, juste une URL à
donner aux élèves.

## Installer l'extension (alternative)

1. `chrome://extensions` → activer le **mode développeur** (en haut à droite).
2. **Charger l'extension non empaquetée** → sélectionner le dossier `extension/`.
3. Cliquer sur l'icône de l'extension → **Ouvrir l'IDE**.
4. En haut de l'IDE, renseigner l'URL de ton serveur de compilation (voir ci-dessous).

À réserver aux postes où le mode développeur est disponible (le tien, par exemple), ou à une
publication Chrome Web Store + liste blanche admin pour un déploiement large.

## Déployer le serveur de compilation

Le `Dockerfile` embarque `arduino-cli` avec le cœur `arduino:avr` déjà installé (pas de
téléchargement à chaque compilation).

```bash
cd backend
docker build -t arduino-compile-server .
docker run -p 8080:8080 arduino-compile-server
```

Tu peux le déployer où tu veux : Cloud Run, Fly.io, Render, ou même directement sur ta
machine Lubuntu exposée sur le réseau du lycée. Pour un premier test en local sans Docker :

```bash
cd backend
npm install
# arduino-cli doit être installé et arduino:avr core disponible :
#   curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh
#   arduino-cli core install arduino:avr
npm start
```

Puis dans l'IDE, mets `http://localhost:8080` (ou l'URL de ton déploiement) dans le champ
"Serveur de compilation".

⚠️ **Sécurité** : ce serveur exécute un compilateur sur n'importe quel code qu'on lui envoie.
Il est pensé pour un réseau de confiance (salle de classe / réseau interne), pas pour être
exposé publiquement sans authentification. Pour une salle de classe, un simple accès réseau
local (ou une URL non devinable) suffit ; pour aller plus loin, ajoute une clé partagée dans
l'en-tête des requêtes.

## Cartes supportées

Le flasheur implémente le protocole **STK500v1**, utilisé par le bootloader des cartes AVR
classiques :

| Carte | FQBN | Vitesse |
|---|---|---|
| Arduino Uno | `arduino:avr:uno` | 115200 |
| Arduino Nano (bootloader récent) | `arduino:avr:nano:cpu=atmega328` | 115200 |
| Arduino Nano (ancien bootloader) | `arduino:avr:nano:cpu=atmega328old` | 57600 |
| Arduino Nano (ATmega168) | `arduino:avr:nano:cpu=atmega168` | 19200 |

**Pas encore supporté** : Arduino Mega2560 (protocole STK500v2, différent) et les cartes
ESP32/ESP8266 (protocole de flash complètement différent, basé sur leur ROM bootloader).
Ce serait une extension naturelle du projet si tu en as besoin pour d'autres TP.

## Limites connues / pistes d'amélioration

- Pas de gestion des bibliothèques externes côté compilation (seulement le cœur
  `arduino:avr` — largement suffisant pour la plupart des TP SIN, mais à étendre si tu
  utilises des capteurs avec bibliothèque tierce : `arduino-cli lib install ...` dans le
  Dockerfile).
- Le moniteur série et le flash se partagent le même port : normal (un seul programme peut
  parler au port à la fois), géré automatiquement par l'extension.
- La vérification de signature protège contre un mauvais choix de carte dans le menu
  déroulant, mais reste à tester sur du matériel réel — je n'ai pas pu tester le flash sur
  une vraie carte dans cet environnement de développement.

## Pourquoi cette architecture plutôt qu'un compilateur 100% navigateur ?

Un vrai `avr-gcc` compilé en WebAssembly existe en théorie, mais c'est un chantier en soi
(portage de la toolchain + de `avr-libc` + du cœur Arduino) et le résultat serait plus
fragile qu'un `arduino-cli` classique côté serveur. Séparer compilation (serveur) et flash
(navigateur, via Web Serial) donne un système qui marche aujourd'hui, avec le gros avantage
pour du matériel scolaire : rien à installer sur les Chromebooks des élèves.

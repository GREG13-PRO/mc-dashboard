# Minecraft Dashboard

Webes felügyeleti panel BungeeCord + alszerverekhez: indítás/leállítás, élő konzol,
fájlkezelő és RCON játékoslista, `screen` session-ökön keresztül.

Ez a projekt **csak Linuxon futtatható és tesztelhető** — a dashboard a `screen`
parancson keresztül indítja/kezeli a szervereket, ami Windows alatt nincs meg. A
kódot írni bárhol lehet, de telepíteni/futtatni a Linux szerveren kell.

## Előfeltételek a Linux szerveren

```bash
sudo apt update
sudo apt install -y screen nodejs npm
node --version   # legyen >= 18
```

A projektnek nincs natív (fordítást igénylő) függősége, így `build-essential`/
`python3` nem szükséges — a konzol a `screen` logfájljának olvasásával működik,
nem natív pty-vel.

**Fontos:** a dashboard-ot mindig ugyanazzal a Linux felhasználóval indítsd, mint
amelyik a Minecraft mappákat birtokolja és a `screen` session-öket létrehozza —
a `screen -ls` csak az adott felhasználó saját session-jeit látja.

## Telepítés

```bash
git clone <ez a repo> mc-dashboard
cd mc-dashboard
npm install
cp backend/.env.example backend/.env
```

Szerkeszd a `backend/.env` fájlt:
- `SESSION_SECRET`: hosszú random string
- `ADMIN_PASSWORD_HASH`: generáld le:
  ```bash
  node -e "console.log(require('bcryptjs').hashSync('ide-a-jelszavad', 10))"
  ```
  (futtatható a `backend` mappából `npm install` után)

## Fejlesztői indítás

Két terminálban:

```bash
npm run dev:backend    # http://localhost:3000 API + WS
npm run dev:frontend   # http://localhost:5173 (proxyzza az API/WS-t a backendre)
```

Fejlesztéskor a böngészőben az 5173-as portot nyisd meg.

## Éles build és indítás

```bash
npm run build   # backend tsc + frontend vite build
npm start       # egyetlen Node process, ami az API-t és a beépített frontendet is szolgálja
```

Alapértelmezett port: 3000 (`backend/.env`-ben állítható).

## Futtatás systemd service-ként (ajánlott)

A `deploy/mc-dashboard.service` sablon telepíti a dashboardot systemd service-ként,
hogy szerver-újraindításkor automatikusan elinduljon és összeomlás esetén
újrainduljon:

```bash
sudo cp deploy/mc-dashboard.service /etc/systemd/system/
# szerkeszd benne a User= és WorkingDirectory= sorokat, ha nem /home/minecraft/mc-dashboard-ban van
sudo systemctl daemon-reload
sudo systemctl enable --now mc-dashboard
```

**Kritikus, ha saját unit fájlt írsz:** mindenképp állítsd be a `KillMode=process`
sort, és az `ExecStart`-ban közvetlenül a `node dist/index.js`-t hívd (ne
`npm start`-ot). Anélkül systemd alapból az egész cgroupot (a dashboard ÉS a
`screen`-nel indított Minecraft szerverek Java processzei is ide tartoznak)
leállítja/kilövi minden `restart`/`stop` esetén — ez pont azt az előnyt veszi el,
amiért `screen`-t használunk (hogy a szerverek túléljék a dashboard
újraindítását). Az `npm start` viszont annyi shell/npm réteget rak a valódi
node process köré, hogy `KillMode=process` mellett systemd sosem a tényleges,
portot tartó processzt követi — emiatt egy restart nem állítja le a régit,
és a következő induláskor port-ütközéssel crash-loopol. A sablon mindkettőt
helyesen kezeli.

## Szerver hozzáadása

A "+ Új szerver" gombbal add meg:
- **Név**: bármi (pl. "BungeeCord Proxy", "Survival")
- **Mappa**: a szerver abszolút útvonala a Linux gépen (pl. `/home/mc/proxy`)
- **Start script**: a mappán belüli fájl neve (pl. `start.sh`) — nem kell futtathatónak
  lennie, a dashboard `bash`-sel hívja meg
- **Stop parancs**: amit a konzolba küld leállításkor (Spigot/Paper/vanilla: `stop`;
  egyes BungeeCord verziók `end`-et várnak — ellenőrizd a saját verziódnál)
- **RCON** (opcionális, a játékoslistához): a szerver `server.properties` fájljában
  engedélyezd:
  ```properties
  enable-rcon=true
  rcon.port=25575
  rcon.password=valami-eros-jelszo
  ```
  BungeeCord proxy-hoz jellemzően nincs natív RCON, ott hagyd kikapcsolva.

## Biztonság

- A jelszó bcrypt hash-ként van tárolva `.env`-ben, a bejelentkezés rate-limitelt.
- Ha a dashboard a helyi hálózaton kívülről is elérhető, tegyél elé egy
  reverse proxy-t (nginx/Caddy) HTTPS-sel — a jelszó plain HTTP felett
  lehallgatható.
- A fájlkezelő minden művelete a szerver saját mappájára van korlátozva
  (path-traversal és symlink-escape védelemmel), de RCON jelszavak
  `backend/data/servers.json`-ban tárolódnak — ne kerüljön verziókezelésbe
  (a `.gitignore` már kizárja), és állítsd `chmod 600`-ra a fájl jogosultságát.

## Ismert korlátok

- Ha egy `start.sh` saját újraindító ciklust tartalmaz (`while true` a java process
  körül), a Stop gomb az in-game `stop` parancsot küldi, ami a JVM-et állítja le,
  de a wrapper script újraindíthatja. Ilyenkor a `screen -S <name> -X quit`
  (amit a dashboard 30 mp timeout után automatikusan megtesz) az egész
  session-t, és vele a wrapper scriptet is leállítja.
- A dashboard újraindítása nem érinti a futó Minecraft szervereket (azok a
  `screen` session-ökben tovább futnak), de a konzol WebSocket kapcsolat
  automatikusan újracsatlakozik pár másodpercen belül.

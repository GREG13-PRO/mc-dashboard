# Minecraft Dashboard — asztali alkalmazás

A dashboard asztali burka. Nem tartalmazza a szervert: a backendnek továbbra is a
Minecraft-szerverek mellett kell futnia (a `screen`, a `ps` és a világmappák ott
vannak), az app csak megkérdezi, hol találja, és megjeleníti.

## Első indítás

Az app egy beállító képernyővel indul, ahol meg kell adni a dashboard **címét
és portját** (alapértelmezés: 3000). A cím ellenőrzésre kerül, mielőtt
elmentődne — ha nem érhető el, ott is marad, hibaüzenettel.

A mentett cím később a **Kapcsolat → Szerver címének módosítása…** menüből
változtatható.

## Fejlesztés

```bash
cd desktop
npm install
npm start
```

## Telepítők készítése

```bash
npm run dist:mac   # .dmg (csak macOS-en fut le)
npm run dist:win   # .exe (Windows runner kell hozzá, lásd a workflow-t)
```

A kimenet a `release/` mappába kerül. Tagre a
`.github/workflows/desktop-release.yml` mindkettőt legyártja.

## Aláírás

A build **nincs aláírva** — nincs hozzá Apple Developer ID, sem Windows
tanúsítvány. Ezért:

- macOS: első indításkor a Gatekeeper blokkolja. Jobb klikk az appra →
  **Megnyitás** → **Megnyitás**. Ezt egyszer kell megtenni.
- Windows: a SmartScreen figyelmeztet. **További információ** → **Futtatás
  mindenképp**.

Aláírt build csak fizetős fejlesztői tanúsítvánnyal lehetséges; ha az egyszer
meglesz, a workflow-ban a `CSC_IDENTITY_AUTO_DISCOVERY` kikapcsolását kell
visszavonni és a tanúsítványt titokként megadni.

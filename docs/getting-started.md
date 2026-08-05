# Your first Minecraft server, start to finish

This guide assumes you have never run a Minecraft server before. It does not
assume you know what a JAR file is, what `server.properties` does, or what a
port number is for. Where those come up, they are explained once and then used.

Everything here is done by clicking. There is one command to type, at the very
start, to install the dashboard itself.

**Contents**

1. [What this actually is](#1-what-this-actually-is)
2. [Installing the dashboard](#2-installing-the-dashboard)
3. [Making your first server](#3-making-your-first-server)
4. [Starting it and joining](#4-starting-it-and-joining)
5. [The five screens](#5-the-five-screens)
6. [Changing a setting without hunting for it](#6-changing-a-setting-without-hunting-for-it)
7. [The things everyone wants to change first](#7-the-things-everyone-wants-to-change-first)
8. [Letting friends in from the internet](#8-letting-friends-in-from-the-internet)
9. [When something goes wrong](#9-when-something-goes-wrong)
10. [When you outgrow simple mode](#10-when-you-outgrow-simple-mode)

---

## 1. What this actually is

A Minecraft server is a program that runs on a computer and keeps a world
running, so that several people can be in the same world at the same time. It
has no window and no buttons — normally you run it in a terminal and control it
by typing commands.

This dashboard is a web page that runs that program for you. You open it in a
browser, press Start, and the server starts. You change a setting with a switch
instead of editing a text file. The world shows up as a map you can look at.

**What you need:**

- A computer running Linux that stays on. A cheap VPS, an old laptop, a
  Raspberry Pi 4 or better, a virtual machine — anything.
  Windows and macOS can *open* the dashboard, but the server itself has to run
  on Linux.
- About 2 GB of RAM free for a small survival server. 4 GB if you want plugins
  and a few friends.
- Java. The installer checks for it and tells you if it is missing.

**What you do not need:** a paid host, a domain name, port forwarding (not
until [section 8](#8-letting-friends-in-from-the-internet)), or any knowledge of
the command line beyond copying one line.

---

## 2. Installing the dashboard

On the Linux machine:

```bash
sudo apt update
sudo apt install -y screen nodejs npm openjdk-21-jre-headless
git clone https://github.com/GREG13-PRO/mc-dashboard.git
cd mc-dashboard
npm install
npm run build
npm start
```

That is the one command block in this guide. What it does: installs the
things the dashboard needs, downloads it, builds it, and runs it.

Now open a browser and go to `http://<the machine's address>:3000`. On the
machine itself that is `http://localhost:3000`. On another computer on the same
network, use the machine's local address — something like `192.168.1.40`.

The first screen asks you to make an admin account. Pick a real password: this
account can start, stop and delete servers.

> **Keep it running after you close the terminal.** The commands above stop
> when you shut the terminal window. To keep the dashboard running for good,
> the repository's main README has the systemd service file to install.

---

## 3. Making your first server

Press the **+** next to **Servers** in the left sidebar.

The window that opens is in **Simple mode**, which asks four things:

| Field | What to put |
|---|---|
| **Name** | Anything. `My server` is fine. It is only a label. |
| **Type** | **Paper**, unless you have a reason not to — see below. |
| **Version** | The Minecraft version your friends will connect with. Pick the newest one you all have. |
| **Memory** | 2048 MB for a small survival world. |

Everything else — the folder, the port, the start script, the JVM flags — is
filled in for you and can be changed later.

**Which type?**

- **Paper** — vanilla Minecraft, but much faster, and it accepts plugins.
  This is the right answer for almost everybody. Nothing about the game
  changes; the server just handles more players on the same hardware.
- **Vanilla** — exactly what Mojang ships. Slower, no plugins. Choose this only
  if you specifically want nothing added.
- **Purpur** — Paper with extra settings to fiddle with. Fine, but Paper first.
- **Fabric / Quilt / Forge / NeoForge** — for playing with *mods*, which every
  player must also install. Do not start here.
- **BungeeCord / Velocity** — these join several servers into one network. They
  are not a server you can play on. Not for a first server.

**Before Create there is one tick box: the EULA.** A Minecraft server refuses
to run until you have accepted
[Mojang's End User Licence Agreement](https://aka.ms/MinecraftEULA) — that is
their rule, not this dashboard's. Ticking it is what writes `eula=true` into
the server folder. Nothing is created until you do, and it is worth reading
once. (Servers that only route players between other servers — BungeeCord and
Velocity — are not Minecraft servers and are not asked.)

Press **Create**. The dashboard downloads the server and sets up the folder.
This takes a minute or two on a normal connection.

---

## 4. Starting it and joining

Your new server is in the sidebar. Click it, then press **Start**.

The **Console** tab shows what the server is doing. The first start is the slow
one: it generates the world. Watch for a line ending in:

```
Done (31.457s)! For help, type "help"
```

That is the server saying it is ready.

Now open Minecraft, go to **Multiplayer → Direct Connection**, and enter the
address:

- On the same machine: `localhost`
- On the same home network: the machine's local address, e.g. `192.168.1.40`

If you changed the port from 25565, put it after a colon: `192.168.1.40:25566`.

You should be in your own world.

---

## 5. The five screens

A new installation starts in **Simple mode** — the pill at the right-hand end
of the tab row. It shows five screens instead of twenty-one. Everything else
still exists; it is one click away when you want it.

**Overview** — is it running, how much memory is it using, how many people are
on, what version is it. The screen to look at when someone says "is the server
down?"

**Console** — the server's own output, live, and a box to type commands into.
The two worth knowing:

- `op YourName` — makes you an operator, so you can use `/gamemode`, `/tp` and
  the rest in game.
- `stop` — shuts the server down properly. (The Stop button does the same
  thing.)

**Players** — who is online, and the buttons to kick, ban or op them without
typing anything.

**World** — a map of your world, generated from the actual world files. Drag to
move, scroll to zoom, press **3D** to tilt it. Useful straight away for finding
where somebody built something.

**Settings** — the server's settings, as switches and dropdowns rather than a
text file. In Simple mode this shows the twelve that a new server is actually
set up with. The rest are still searchable — see the next section.

---

## 6. Changing a setting without hunting for it

This is the part worth putting in your video, because it is what makes the
difference between a five-minute setup and an afternoon.

**Press `Ctrl+K`** (or `⌘K` on a Mac), or click the search box in the top right,
or just press `/`.

Type what you want. Not where it lives — *what it is*.

| Type this | You get |
|---|---|
| `pvp` | The PvP switch, opened, with everything else out of the way |
| `difficulty` | The difficulty dropdown |
| `keepinv` | The `keepInventory` game rule |
| `whitelist` | The whitelist switch |
| `seed` | Your world's seed |
| `creeper` | `mobGriefing` — the rule that stops creepers wrecking builds |
| `map` | The map screen |

Press **Enter** and you land on the actual control, with the row highlighted.
Not the tab it lives on — the control.

This works for all sixty-eight server properties, the common game rules, every
tab, and every server you have. It searches descriptions too, so you can find
something by what it does when you cannot remember what it is called.

---

## 7. The things everyone wants to change first

Each of these is `Ctrl+K`, type, Enter.

**"I want it to be just my friends."**
Search `whitelist`, turn it on. Then in the Console, for each friend:
`whitelist add TheirName`. Anyone not on the list is refused.

**"I keep losing my stuff when I die."**
Search `keepinv`, turn `keepInventory` on.

**"Creepers keep blowing up my house."**
Search `creeper`, turn `mobGriefing` off. This also stops endermen moving blocks
and zombies breaking doors.

**"It is too hard / too easy."**
Search `difficulty`. `peaceful` removes hostile mobs entirely.

**"I want the server name in the server list to say something."**
Search `motd`. This is the line under the server name in Minecraft's server
list.

**"The server is laggy."**
Search `view-distance` and lower it — 10 is the default, 6 or 7 makes a large
difference and is barely noticeable in play. That one setting does more than
anything else on modest hardware.

> **Some settings only apply after a restart.** Those are marked. Change it,
> then press Restart.

---

## 8. Letting friends in from the internet

Everything so far works on your own network. For someone elsewhere to join,
their connection has to reach your machine, and by default your router will not
let it.

**The easy way — Playit.gg or a similar tunnel.** A small program on your
machine that gives you a public address. No router settings, works behind any
connection including mobile broadband. This is what to recommend to a beginner.

**The direct way — port forwarding.** In your router's settings, forward TCP
port 25565 to your machine's local address. Your friends then connect to your
home's public IP.

Two things to say out loud if you are making a video about this:

- Port forwarding exposes that machine to the internet. Before you do it, open
  the **Security** tab (turn off Simple mode to see it) and deal with anything
  it flags. It checks for exactly the things that get servers attacked.
- Your home IP usually changes every few days. A free dynamic-DNS name saves
  re-telling everyone the number.

---

## 9. When something goes wrong

**The server stops right after starting.** Open Console and read upward from
the bottom. The real error is usually four or five lines above the last line.

**"Failed to bind to port".** Something else is already using that port —
usually another copy of the same server that did not shut down. Press Kill,
then Start.

**"Outdated server!" or "Outdated client!" when joining.** Your Minecraft
version and the server's do not match. The version is on the Overview screen;
change Minecraft's to match, or make a new server on the right version.

**Java errors on startup.** Newer Minecraft needs newer Java. 1.20.5 and above
want Java 21. `sudo apt install openjdk-21-jre-headless`.

**It runs, but it is unbearably slow.** Check memory on Overview. If it is
pinned at its limit, either give it more or lower `view-distance`. A server
short of memory pauses constantly.

**You locked yourself out with the whitelist.** Console:
`whitelist off`.

---

## 10. When you outgrow simple mode

Press the **Simple** pill in the tab row and everything appears. Briefly, what
you have been missing:

- **Plugins** — a browser that installs plugins from Spigot, Modrinth and
  Hangar directly. Start with EssentialsX (homes, warps, `/tpa`), LuckPerms (ranks and
  permissions), and CoreProtect (undo any griefing).
- **Schematics** — upload a build, place it on the 3D map, and see exactly where
  it will land before it is written into the world.
- **Schedules** — automatic restarts and backups. Set a nightly backup on day
  one; the first time you need it you will not have to be told twice.
- **Security** — a scan of the things that get servers broken into, with a
  button to fix each one and a button to say "I know, it is deliberate".
- **Timeline / Performance / Statistics** — what changed and when, where the lag
  comes from, who plays and for how long.
- **Backups** — a full copy of the server folder, one button, restorable.

The search box reaches all of it from wherever you are.

---

## A note on the dashboard's own updates

Under **Manage → Apps** the dashboard publishes its own desktop and phone
builds. It checks GitHub every six hours and offers the newer version to every
copy of the app on your network. Nothing installs itself — each one asks first.

# ধনি হবার মোজার খেলা · Dhoni Hobar Mojar Khela

A multiplayer web board game in the mould of the Bangladeshi home Monopoly copy —
a 40-tile board of Dhaka streets, railways and landmarks, 2–4 players over the
network, and a lightly 3D board built with Three.js.

```
npm install
npm start          # http://localhost:3000
npm test           # 557 checks across the engine, client, bots and sockets
```

Open the page in two browser windows to play against yourself, add bots to fill
the empty seats, or share the four-character room code with friends.

---

## Playing

| Action | How |
| --- | --- |
| Create a game | Type a name → **নতুন খেলা খুলুন** |
| Fill a seat | **🤖 বট যোগ করুন** — a bot plays the group-chasing strategy below |
| Join a friend | Type their four-character **room code** → **যোগ দিন** |
| Start | The first player in the room presses **খেলা শুরু করুন** (needs 2+) |
| Play | **ডাইস ফেলুন**, then buy, build or mortgage before passing on |
| Trade | The **ট্রেড** tab: tick titles and cash on each side, send, wait |
| Look around | Drag to orbit, scroll to zoom, click a tile for its details |

Keys: <kbd>Space</kbd> or <kbd>Enter</kbd> rolls when it is your turn,
<kbd>Esc</kbd> closes a dialog.

Leaving mid-game is a surrender — your titles go to the bank and you are out.

## The board

Standard Monopoly layout, localised. 40 tiles, 28 of them purchasable, grouped
into the usual colour bands so monopolies work the same way.

| Group | Tiles |
| --- | --- |
| ক · গলি | কালীবাজার, পাটুয়াঘাটা |
| গ · মহল | লালবাজার, ইসলামপুর, বেইরপুর |
| হ · গেম | নিজামাবাদ, গ্রীন রোড, বাংলাবাজার |
| ঘ · বিলাস | ধানমন্ডি, বনানী, গুলশান |
| চ · টাওয়ার | উত্তরা মডেল টাউন, যতীপুর, ধীরনগর |
| জ · খেলার মাঠ | মিরপুর, ফার্মগেট, কালীপুর |
| ট · বাণিজ্য | সোনারগাছী, জাতীয় সংসদ, ধানবাড়ি |
| ভ · বিজলি | পুরান ঢাকা, বায়তুল মোকাররম |
| র · স্টেশন | ঢাকা, নারায়ণগঞ্জ, চট্টগ্রাম, সিলেট |
| ব · সেবা | বিদ্যুৎ, পানি |

Starting cash ৳1,500. Passing START pays ৳200. Rent tables, house prices and
mortgage values follow the standard Monopoly economy.

## Rules implemented

Full Monopoly, all server-authoritative:

- Two dice, doubles re-roll, three doubles in a row sends you to jail
- Buying, and declining to buy
- Colour groups with the even-build rule; four houses, then a hotel
- Selling buildings back at half price
- Mortgaging for half the price, un-mortraging at half plus ten percent
- Rent scaling: rail stations charge by how many you hold, utilities are a
  multiple of the dice, developed properties use the house table
- Jail: three turns or a ৳50 fine, doubles release you
- **সুযোগ** (Chance) and **ভাগ্য** (Bhagya) decks, 16 cards each, reshuffled when
  exhausted — including *go to jail*, *back three*, *advance to the nearest
  station* and the get-out-of-jail card
- Income tax ৳200, luxury tax ৳100, free parking
- Trading between players: any undeveloped titles plus cash, both ways
- Bankruptcy: debts pass to the creditor when there is one, otherwise the bank
  takes the titles. Last player standing wins.

### Bots

Fill empty seats with bots, or let them run the whole table. The policy chases
colour groups and then raises houses on them.

That second half is not decoration. A bot that buys randomly never completes a
group, so nobody builds anything, rent pressure evaporates, and the ৳200 START
salary compounds until the game cannot end — during testing one player reached
৳151,000 with nothing to spend it on. Building is what makes a game resolve, so
in 200 bot-versus-bot games roughly nine in ten now finish by bankrupting the
opposition rather than by hitting the round limit.

### One deliberate departure from classic Monopoly

Classic Monopoly has **no natural ending**. Once every title is sold, the ৳200
START salary keeps compounding until rent can no longer bankrupt anybody.

So games also end on a round limit (default **200 rounds**), at which point the
player with the highest net worth wins. Most games still finish earlier through
bankruptcy; this only stops the ones that never would. Override with:

```
MAX_ROUNDS=400 npm start
```

### Reconnecting, and what happens if you cannot

Every seat gets a token, kept in `localStorage`. A refresh or a dropped line
reconnects you to the same seat with your cash, titles and turn intact — you get
a minute to get back before the seat is forfeit. `ALLOWED_ORIGIN`-restricted
sockets reconnect on their own; there is nothing to press.

Games are written to disk after every change (atomically, debounced), so a
restart or a deploy does not lose games in progress. A corrupt save is ignored
rather than allowed to stop the server booting.

---

## Deploying

**Free, no credit card — [Zendevz](deploy/zendevz.md).** A Bangladeshi
card-free cloud: a real Linux VM with root, a free subdomain and SSL. One
command installs the game, and it comes back by itself after a reboot.

```bash
curl -fsSL https://raw.githubusercontent.com/m7real/dhoni-hobar-mojar-khela/main/deploy/install.sh | sudo bash
```

Read [deploy/zendevz.md](deploy/zendevz.md) first — Zendevz is in alpha and says
it is not built for production, and the game goes offline whenever your own
machine sleeps if the VM lands there.

**Paid alternative — Render.** `render.yaml` deploys to
[Render](https://render.com), which needs a credit card for the persistent
disk. Nothing about the game is Zendevz-specific: it is plain Node.js on a
Linux box with a writable directory, so either target works.

To deploy manually, it is four steps:

```bash
npm ci --omit=dev
NODE_ENV=production PORT=3000 STORE_DIR=./data/rooms npm start
```

Reverse-proxy it with anything that supports WebSocket upgrades (Caddy, nginx,
or no proxy at all if your host opens ports directly), and set
`ALLOWED_ORIGIN` to the address players will use.

---

## The 3D

Deliberately light: a Three.js board rather than a 3D game.

- 40 tiles as bevelled boxes with a colour band on the inner edge, laid out on
  a felt-topped table with soft shadows
- Colour-coded pawns that hop tile to tile around the ring; movement is derived
  by diffing board positions, so a *back three spaces* card animates backwards
- Two real 3D dice with pip textures that tumble and settle on their true face
- Houses stack as little green cubes on the tile; a hotel becomes a red block
- Tile names are HTML labels projected onto the 3D scene, so Bengali text stays
  crisp instead of being blurred into a texture
- Drag to orbit, scroll to zoom, click a tile for rent, owner and mortgage value

Three.js is served from `node_modules` rather than a CDN, so the game works
offline.

---

## Sound

Every sound is synthesised with WebAudio at runtime — no audio files, nothing
to license or download. Dice tumble as filtered noise bursts, purchases are a
rising arpeggio, bankruptcy falls, and a win gets a small fanfare. The 🔊 button
mutes, the choice is remembered, and audio only starts after your first click,
which is what browsers require.

---

## Layout

```
server/
  board.js     40 tiles, rent tables, both card decks
  game.js      the rules engine — no networking, pure turn state machine
  bot.js       bot policy: chase groups, then build houses
  store.js     atomic, debounced JSON persistence
  index.js     express + socket.io, rooms, validation, bot scheduler
client/public/
  index.html
  css/style.css
  js/scene.js  Three.js board, pawns and dice
  js/audio.js  synthesised sound
  js/ui.js     HUD, panels, dialogs, toasts
  js/main.js   socket wiring
deploy/
  install.sh   idempotent installer and updater
  dhoni-hobar-mojar-khela.service   systemd unit
  dhoni-hobar-mojar-khela.env.example
  zendevz.md   how to deploy without a credit card
test/
  engine.test.js       rules, board shape, 60 full random games
  client.test.js       the real UI against real payloads, in jsdom
  trade.test.js        trade validation and a conservation fuzz
  bot.test.js          bot legality, 200 full bot games, live socket play
  server.test.js       two real clients playing over a real server
  trade.socket.test.js trading over the wire
  reconnect.test.js    tokens, resume, the grace period
  persist.test.js      serialiser round-trips, corruption, a real restart
  deploy.test.js       config files, headers, CORS enforcement
```

The engine has no idea sockets exist, which is what lets it play thousands of
games in a test run. Every player action — from a socket *or* from a bot — goes
through the same guarded methods on `Game`, so neither can do anything the other
could not. The server re-sends the whole game state after every change, and each
client gets its own view of it, since trade offers are directed.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket port |
| `STORE_DIR` | `data/rooms` | Where saved games are written |
| `ALLOWED_ORIGIN` | *(any)* | Comma-separated origins allowed to connect |
| `MAX_ROUNDS` | `200` | Rounds before the richest player wins |
| `RESUME_GRACE_MS` | `60000` | Time a dropped player has to return |
| `NODE_ENV` | — | `production` enables caching and quiets logs |
# Deploying to Zendevz

[Zendevz](https://www.zendevz.com) is a card-free cloud built in Bangladesh. You
get a real Linux VM with root, a free subdomain and SSL, and — importantly —
**you never need a credit card**.

This is the cheapest way to put this game online. It is also the least serious,
so read the two warnings first.

---

## Read this before you start

**1. Zendevz is in alpha and says so itself.** From their FAQ: *"No — not yet.
Zendevz is in early alpha and isn't built for production workloads: don't put
anything business-critical on it. It's a great fit for learning, side projects,
staging, and experiments."* A game you play with friends is exactly that. If
this ever grows real users or real money, move it.

**2. The game may go offline whenever your own computer sleeps.** Zendevz runs
VMs on machines that people contribute, and yours can run on either your own PC
or a peer's. Their FAQ is blunt about it: *"Your Private VM goes offline when
your machine is off — and comes back automatically when it powers on."*

So if your VM lands on your own machine, the game is unreachable while that
machine is off, and comes back on its own when you power it on. Check which node
your VM is on. If it is on your own PC, either keep the PC awake and wired in,
or create a new VM and hope for a peer node.

**3. `zctl` does not run on Windows.** It supports Linux and macOS, with WSL
"on the roadmap". That is fine — you create the VM in the web console and then
SSH in, and Windows has an SSH client built in. You only need `zctl` locally if
you want it.

---

## What you need

- A Zendevz account: [console.zendevz.com](https://console.zendevz.com) — sign
  in with Google. Bangladesh only, for now.
- Nothing else. No card.

---

## Step 1 — Create the VM

In the console, create a VM:

- **Flavor:** `krab.small` — 2 vCPU, 4GB RAM, 40GB NVMe. This game needs about
  100MB of that, so it is wildly oversized in your favour.
- **Name:** anything, e.g. `dhoni`

When it is running, note **which node it landed on** (yours or a peer's). That
tells you whether the uptime caveat above applies to you.

## Step 2 — SSH in

From Windows (PowerShell or Command Prompt), `ssh` is already available:

```powershell
ssh root@<the-address-the-console-gives-you>
```

Use `zctl ssh <vm-name>` if you have `zctl` on a Linux or macOS machine.

## Step 3 — Run the installer

Paste this into the VM:

```bash
curl -fsSL https://raw.githubusercontent.com/m7real/dhoni-hobar-mojar-khela/main/deploy/install.sh | sudo bash
```

That installs Node.js 22, clones the game, installs dependencies, writes a
configuration file, and runs it under systemd with `Restart=always`.

It finishes by checking the game actually answers, and prints what to do next.

<details>
<summary>Prefer to see what it does first?</summary>

```bash
git clone https://github.com/m7real/dhoni-hobar-mojar-khela.git
cd dhoni-hobar-mojar-khela
less deploy/install.sh
sudo bash deploy/install.sh
```
</details>

## Step 4 — Expose it with a subdomain

In the Zendevz console, open **Elastic Edge** for your VM and forward
**port 3000**. You get something like:

```
https://dhoni.zendevz.com
```

SSL is handled for you — there is nothing to configure.

## Step 5 — Tell the game its own address

The installer left a placeholder in the configuration. Put your real address in:

```bash
sudo nano /etc/dhoni-hobar-mojar-khela.env
```

Find this line and change it:

```
ALLOWED_ORIGIN=https://REPLACE-ME.zendevz.com
```

to your actual subdomain, then:

```bash
sudo systemctl restart dhoni-hobar-mojar-khela
```

**Do not skip this.** While it is unset the server accepts connections from any
website, which is fine on your laptop and wrong the moment it is online.

## Step 6 — Play

Open the subdomain in two browser windows. Create a room in one, type the
four-character code into the other. Or press **🤖 বট যোগ করুন** and play
against the computer.

---

## Checking it works

```bash
# Is the service up?
sudo systemctl status dhoni-hobar-mojar-khela

# What is it saying?
sudo journalctl -u dhoni-hobar-mojar-khela -f

# Does it answer?
curl -s https://<your-subdomain>.zendevz.com/health
```

A healthy game answers:

```json
{"ok":true,"rooms":0}
```

## Updating after a change

Push to GitHub, then on the VM:

```bash
sudo /opt/dhoni-hobar-mojar-khela/deploy/install.sh
```

It pulls the new code, reinstalls, and restarts. **It never overwrites your
configuration**, so your subdomain setting survives.

Games in progress survive this: the process is restored from disk on boot, and
anyone connected gets a minute to reconnect automatically.

---

## Is it using WebSockets?

This is worth knowing, because it changes how responsive the game feels.

Zendevz's docs are behind a login, so I could not confirm whether their edge
proxy forwards the HTTP `Upgrade` header that WebSockets need. **You do not need
to resolve this — the game works either way.** The client asks for a WebSocket
first and quietly falls back to HTTP long-polling, so it plays correctly on a
proxy that blocks upgrades, just slightly less smoothly.

To see which you got, open your browser's developer console on the game page and
look at the Socket.IO connection line: it says `transport: websocket` or
`transport: polling`.

---

## When something goes wrong

| Symptom | Try |
| --- | --- |
| Game loads but two players cannot see each other | `ALLOWED_ORIGIN` is probably still the placeholder. Fix and restart. |
| Subdomain will not resolve | Elastic Edge is not forwarding port 3000, or is pointed at the wrong port. Check both. |
| Service will not start | `sudo journalctl -u dhoni-hobar-mojar-khela -n 50 --no-pager` |
| "SAVING IS DISABLED" in the logs | The data directory is not writable. Check `STORE_DIR` matches the `ReadWritePaths` in the unit file. |
| Game worked yesterday, not today | Your PC slept and the VM went with it. See warning 2. |
| Port already in use | Change `PORT` in the env file, and forward the new port in Elastic Edge. |

Games are saved to `STORE_DIR` (default
`/opt/dhoni-hobar-mojar-khela/data/rooms`) as one JSON file per room, and are
reloaded when the service starts.

---

## A different way to host it

`render.yaml` in the repo root deploys to [Render](https://render.com). It
needs a credit card for the persistent disk, so if you ever get one that is the
more conventional choice. Nothing about the game is Zendevz-specific — it is
plain Node.js on a Linux box with a writable directory.
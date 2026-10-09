# Deploying to an Azure VM

This is the best option if you have an Azure for Students credit: a real Ubuntu
machine with a persistent disk, no alpha caveats, and it renews every year while
you are a student.

Azure for Students gives **$100 of credit for 12 months** plus **750 hours a
month of free B1s Linux VMs**. This game uses about 100MB of RAM and almost no
CPU, so a B1s is more than enough.

---

## What Azure puts in front of you

The game itself installs the same way as anywhere else — it is plain Node.js on
Linux. Three Azure-specific things sit between you and a working game:

| Thing | Why it bites | Fix |
| --- | --- | --- |
| **Network security group** | Inbound traffic is blocked by default, so port 3000 is unreachable even though the server is running fine | Add an inbound rule in the portal |
| **Auto-shutdown** | Some images ship a schedule that powers the VM off at a fixed hour, ending games without warning | Check it, turn it off |
| **"Stopped" still bills** | Shutting down from inside Linux leaves the VM *Stopped*, which still costs money | **Deallocate** from the portal instead |

## Read this before you start

**Your $100 credit is real money.** Azure bills compute, disks, public IPs and
outbound bandwidth against it. A single idle VM left running for months will eat
a surprising share. Set a **budget alert** in the portal (Cost Management →
Budgets) so you get an email rather than a surprise.

**When the credit runs out the subscription is disabled and your resources are
decommissioned.** So when the 12 months ends, either renew as a student
(re-verifying with your school email, which resets the credit) or upgrade to
pay-as-you-go. Do not plan on the VM outliving the credit.

**Saving the games costs extra money too.** The VM's own disk is included in the
VM price, so storing games there is free. Attaching a *separate* managed disk
would be billed separately, so the setup below keeps everything on the VM's own
disk. That is fine for a casual game, but it does mean losing the VM loses the
games — keep the repo as the source of truth.

---

## Step 1 — Allow the port

This is the step that catches people. In the Azure portal:

1. Open your **Virtual machine**.
2. Under **Settings**, choose **Networking**.
3. Choose **Inbound port rules** (or *Inbound security rules*).
4. **Add** a rule:

   | Field | Value |
   | --- | --- |
   | Source | `Any` |
   | Source port | `*` |
   | Destination | `Any` |
   | Service | Custom |
   | Destination port | `3000` |
   | Protocol | TCP |
   | Priority | 100 (or any unused number) |
   | Name | `dhoni` |

Use `Any` as the source so your friends can connect. If you would rather not
expose it to the whole internet, put their home IP in the source instead.

> Adding an NSG rule and letting the *application* firewall (`ufw`) stay
> closed is a common source of confusion: the installer opens `ufw` for you if
> it is active.

## Step 2 — Turn off auto-shutdown

In the portal, under your VM's **Operations** section, check **Auto-shutdown**.

If a schedule is set, either remove it or be aware that the game stops dead at
that time every day and does not come back by itself. A game of saved progress
survives a restart, but nobody can play while it is off.

## Step 3 — SSH in

From your computer:

```bash
ssh <your-azure-username>@<the-vm-public-ip>
```

The portal shows the address under **Overview → Public IP Address**. You need
your SSH key, which Azure offered when you created the VM.

## Step 4 — Install the game

```bash
curl -fsSL https://raw.githubusercontent.com/m7real/dhoni-hobar-mojar-khela/main/deploy/install.sh | sudo bash
```

That installs Node.js 22, clones the game, installs dependencies, writes
`/etc/dhoni-hobar-mojar-khela.env`, and runs it under systemd with
`Restart=always` so it comes back after a crash or a reboot.

It ends by printing your machine's address and checking the game actually
answers.

<details>
<summary>Prefer to read it first?</summary>

```bash
git clone https://github.com/m7real/dhoni-hobar-mojar-khela.git
cd dhoni-hobar-mojar-khela
less deploy/install.sh
sudo bash deploy/install.sh
```
</details>

## Step 5 — Set your address

The installer left a placeholder. Tell the game who is allowed to connect:

```bash
sudo nano /etc/dhoni-hobar-mojar-khela.env
```

Set it to your VM's address, with the port:

```
ALLOWED_ORIGIN=http://203.0.113.42:3000
```

Then restart:

```bash
sudo systemctl restart dhoni-hobar-mojar-khela
```

**Do not skip this.** While it is unset, the server accepts connections from any
website on the internet, which is fine on your laptop and wrong now that it is
public.

## Step 6 — Play

Open `http://<your-vm-ip>:3000` in a browser. Create a room, and press
**🤖 বট যোগ করুন** if you have nobody to play with right now.

---

## There is no HTTPS

Without a domain name there is no certificate — Let's Encrypt does not issue
certificates for bare IP addresses. So the game runs on plain `http://`, which
is fine for playing with friends: the page, the 3D board, saved games and the
sound all work, and the multiplayer connection is WebSocket or long-polling.

The one thing to know is that traffic is not encrypted, so do not put anything
private into a room name or chat.

If you later get a domain, point an A record at the VM and put Caddy or nginx
in front to get HTTPS and an `https://` origin. Nothing in the game needs
changing.

---

## Checking it works

```bash
sudo systemctl status dhoni-hobar-mojar-khela   # is it running?
sudo journalctl -u dhoni-hobar-mojar-khela -f  # what is it saying?
curl -s http://localhost:3000/health            # does it answer?
```

A healthy game answers:

```json
{"ok":true,"rooms":0}
```

If `/health` works locally but the page will not load in a browser, the problem
is the network, not the game — go back to step 1.

## Updating

```bash
sudo /opt/dhoni-hobar-mojar-khela/deploy/install.sh
```

It pulls the newest code and restarts. It never overwrites your configuration,
so your address survives.

Games in progress survive too: the process restores itself from disk, and
anyone connected has a minute to reconnect automatically.

---

## Keeping the cost down

- **Deallocate, do not stop.** From the portal, *Stop* leaves the VM allocated
  and still billing. *Deallocate* releases the compute. You can start it again
  whenever you want.
- **Deallocate when you are not playing** if credits matter more than
  convenience. Start it from the portal before you want to play.
- **Set a budget alert.** Cost Management → Budgets → Create. This is the single
  most useful thing you can do.
- **Watch what else is running.** Public IPs, managed disks and any other VMs
  are billed separately from the VM, and idle ones are the usual culprit.
- **Renew as a student** before the 12 months are up. Re-verifying with your
  school email resets the credit.

## When something goes wrong

| Symptom | Try |
| --- | --- |
| Page will not load, `/health` works locally | The NSG rule is missing or on the wrong port. Step 1. |
| `SAVING IS DISABLED` in the logs | The data directory is not writable. Check `STORE_DIR` matches the `ReadWritePaths` in the unit file. |
| Game went down overnight | Auto-shutdown. Step 2. |
| Service will not start | `sudo journalctl -u dhoni-hobar-mojar-khela -n 50 --no-pager` |
| Two players cannot see each other | `ALLOWED_ORIGIN` does not match the address they are using. |
| The VM is billed while "off" | You stopped it rather than deallocating it. |
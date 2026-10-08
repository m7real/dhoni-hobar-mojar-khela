#!/usr/bin/env bash
#
# Install or update Dhoni Hobar Mojar Khela on a Debian/Ubuntu machine.
#
# Run it on the VM itself:
#     curl -fsSL https://raw.githubusercontent.com/m7real/dhoni-hobar-mojar-khela/main/deploy/install.sh | sudo bash
#
# or clone the repo first and run deploy/install.sh by hand.
#
# The script is idempotent. Running it again pulls the newest code and restarts
# the service, without ever overwriting your configuration.

set -euo pipefail

APP_DIR=/opt/dhoni-hobar-mojar-khela
REPO_URL=${REPO_URL:-https://github.com/m7real/dhoni-hobar-mojar-khela.git}
SERVICE_NAME=dhoni-hobar-mojar-khela
SERVICE_UNIT=/etc/systemd/system/${SERVICE_NAME}.service
ENV_FILE=/etc/dhoni-hobar-mojar-khela.env
SERVICE_USER=dhk
NODE_MAJOR=22

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m error:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo."

# ── 1. base packages ────────────────────────────────────────────────────────

say "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates >/dev/null

# ── 2. Node.js ──────────────────────────────────────────────────────────────

if command -v node >/dev/null 2>&1 && \
   [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then
  say "Node.js $(node -v) already present"
else
  say "Installing Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  command -v node >/dev/null 2>&1 || die "Node.js failed to install."
  say "Node.js $(node -v) installed"
fi

# The unit file points at an absolute path, so make sure it is the one we expect.
command -v node >/dev/null 2>&1 || die "node is not on PATH."

# ── 3. service account ──────────────────────────────────────────────────────

if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  say "Creating the ${SERVICE_USER} service account"
  useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
else
  say "Service account ${SERVICE_USER} already exists"
fi

# ── 4. the code ─────────────────────────────────────────────────────────────

if [ -d "${APP_DIR}/.git" ]; then
  say "Updating the existing installation"
  git -C "${APP_DIR}" fetch --quiet origin
  git -C "${APP_DIR}" pull --quiet --ff-only \
    || die "git pull failed. Resolve it in ${APP_DIR} and re-run this script."
else
  say "Cloning the game into ${APP_DIR}"
  mkdir -p "${APP_DIR}"
  git clone --quiet "${REPO_URL}" "${APP_DIR}" \
    || die "Could not clone ${REPO_URL}."
fi

say "Installing dependencies (production only)"
cd "${APP_DIR}"
npm ci --omit=dev --no-audit --no-fund >/dev/null \
  || npm ci --omit=dev --no-audit --no-fund

# ── 5. data and configuration ───────────────────────────────────────────────

say "Preparing the saved-games directory"
mkdir -p "${APP_DIR}/data/rooms"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"

if [ -f "${ENV_FILE}" ]; then
  say "Keeping your existing configuration at ${ENV_FILE}"
else
  say "Writing a starting configuration to ${ENV_FILE}"
  cp "${APP_DIR}/deploy/dhoni-hobar-mojar-khela.env.example" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  warn "Edit ${ENV_FILE} and put your real subdomain in ALLOWED_ORIGIN,"
  warn "otherwise anyone can connect to your game."
fi

# ── 6. the service ──────────────────────────────────────────────────────────

say "Installing the systemd service"
cp "${APP_DIR}/deploy/dhoni-hobar-mojar-khela.service" "${SERVICE_UNIT}"
chmod 644 "${SERVICE_UNIT}"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1
systemctl restart "${SERVICE_NAME}"

# ── 7. did it actually come up? ─────────────────────────────────────────────

# Read the port out of the config file rather than sourcing it, and rather
# than assuming 3000, so a customised PORT is checked on the port it really
# uses. Otherwise the health check below silently tests the wrong thing.
HEALTH_PORT=$(grep -E '^PORT=' "${ENV_FILE}" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '"'"'"' \r' || true)
HEALTH_PORT=${HEALTH_PORT:-3000}

say "Waiting for the game to answer on port ${HEALTH_PORT}"
up=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${HEALTH_PORT}/health" >/dev/null 2>&1; then
    up=1
    break
  fi
  sleep 1
done

if [ "${up}" -ne 1 ]; then
  warn "The game did not answer /health within 30 seconds."
  warn "Read the logs with:"
  warn "  journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
  exit 1
fi

echo
curl -fsS "http://127.0.0.1:${HEALTH_PORT}/health"; echo

cat <<EOF

$(say "Done. The game is running.")

Next: expose it on the internet.

  1. In the Zendevz console, open Elastic Edge for this VM and forward
     port ${HEALTH_PORT}.
  2. You will get a subdomain like https://<your-vm>.zendevz.com
     with SSL handled for you.
  3. Put that address in ${ENV_FILE}:

       ALLOWED_ORIGIN=https://<your-vm>.zendevz.com

     then:  sudo systemctl restart ${SERVICE_NAME}

  4. Open the address in two browser windows and play a game together.

Useful commands:
  sudo systemctl status ${SERVICE_NAME}
  sudo journalctl -u ${SERVICE_NAME} -f
  sudo ${APP_DIR}/deploy/install.sh     # to update later

To update after a new push, just re-run install.sh. It never overwrites
${ENV_FILE}.
EOF
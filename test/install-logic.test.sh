#!/usr/bin/env bash
#
# Exercises the real logic out of deploy/install.sh against fixtures.
#
# This cannot test the apt-get, git clone or systemctl steps, which need a real
# Debian machine and root. What it does test is the part most likely to be got
# quietly wrong: reading the config file, and refusing to overwrite one that
# already exists. Both are extracted from install.sh itself, so this tests the
# shipped code rather than a copy of it.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="${HERE}/../deploy"
INSTALL_SH="${DEPLOY}/install.sh"

pass=0
fail=0
ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s  -> %s\n' "$1" "${2:-}"; }

WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT

echo
echo "config handling (logic lifted from install.sh)"

[ -f "${INSTALL_SH}" ] || { echo "cannot find ${INSTALL_SH}"; exit 1; }

# Pull the two blocks out of the real script so we exercise the real lines.
PORT_LINE=$(grep -F 'HEALTH_PORT=$(grep' "${INSTALL_SH}" | head -n 1)
PRESERVE_BLOCK=$(grep -A11 -F 'if [ -f "${ENV_FILE}" ]; then' "${INSTALL_SH}")

# The block calls say/warn and copies out of APP_DIR, so stand those up.
say()  { :; }
warn() { :; }

if [ -z "${PORT_LINE}" ]; then
  bad "the port-reading line is still in install.sh" "not found"
elif [ -z "${PRESERVE_BLOCK}" ]; then
  bad "the config-preserving branch is still in install.sh" "not found"
else
  ok "both blocks are still present in install.sh"

  # --- port extraction -------------------------------------------------------
  extract() {
    ENV_FILE="$1"
    eval "${PORT_LINE}"
    echo "${HEALTH_PORT:-3000}"
  }

  ENV_FILE="${WORK}/normal.env"
  printf 'PORT=3000\nNODE_ENV=production\n' > "${ENV_FILE}"
  got=$(extract "${ENV_FILE}")
  [ "${got}" = "3000" ] && ok "reads a normal PORT" || bad "reads a normal PORT" "got '${got}'"

  ENV_FILE="${WORK}/custom.env"
  printf 'PORT=8080\nNODE_ENV=production\n' > "${ENV_FILE}"
  got=$(extract "${ENV_FILE}")
  [ "${got}" = "8080" ] && ok "reads a customised PORT" || bad "reads a customised PORT" "got '${got}'"

  ENV_FILE="${WORK}/quoted.env"
  printf 'PORT="8081"\n' > "${ENV_FILE}"
  got=$(extract "${ENV_FILE}")
  [ "${got}" = "8081" ] && ok "strips quotes from PORT" || bad "strips quotes from PORT" "got '${got}'"

  ENV_FILE="${WORK}/crlf.env"
  printf 'PORT=8082\r\n' > "${ENV_FILE}"
  got=$(extract "${ENV_FILE}")
  [ "${got}" = "8082" ] && ok "tolerates a carriage return" || bad "tolerates a carriage return" "got '${got}'"

  ENV_FILE="${WORK}/missing.env"
  got=$(extract "${ENV_FILE}")
  [ "${got}" = "3000" ] && ok "falls back to 3000 when the file is absent" \
    || bad "falls back to 3000 when the file is absent" "got '${got}'"

  ENV_FILE="${WORK}/noports.env"
  printf 'NODE_ENV=production\nMAX_ROUNDS=200\n' > "${ENV_FILE}"
  got=$(extract "${ENV_FILE}")
  [ "${got}" = "3000" ] && ok "falls back when there is no PORT line" \
    || bad "falls back when there is no PORT line" "got '${got}'"

  # The last PORT line should win, since systemd uses the last assignment.
  ENV_FILE="${WORK}/twice.env"
  printf 'PORT=3000\nPORT=9090\n' > "${ENV_FILE}"
  got=$(extract "${ENV_FILE}")
  [ "${got}" = "9090" ] && ok "the last PORT wins, as systemd would" \
    || bad "the last PORT wins, as systemd would" "got '${got}'"

  # --- configuration preservation --------------------------------------------
  ENV_FILE="${WORK}/existing.env"
  printf 'ALLOWED_ORIGIN=https://mine.zendevz.com\n' > "${ENV_FILE}"
  before=$(cat "${ENV_FILE}")
  if eval "${PRESERVE_BLOCK}"; then :; fi   # take the "keep it" branch
  after=$(cat "${ENV_FILE}")
  [ "${before}" = "${after}" ] \
    && ok "an existing configuration is left alone" \
    || bad "an existing configuration is left alone" "it changed"
  grep -q 'mine.zendevz.com' "${ENV_FILE}" \
    && ok "ALLOWED_ORIGIN survives an update" \
    || bad "ALLOWED_ORIGIN survives an update" "it was wiped"

  # And the other branch really does copy the template into place.
  # install.sh copies from ${APP_DIR}/deploy/, so build that shape here.
  APP_DIR="${WORK}/fakeapp"
  mkdir -p "${APP_DIR}/deploy"
  cp "${DEPLOY}/dhoni-hobar-mojar-khela.env.example" "${APP_DIR}/deploy/"

  ENV_FILE="${WORK}/fresh.env"
  if eval "${PRESERVE_BLOCK}"; then
    ok "a missing configuration is created from the template"
  else
    bad "a missing configuration is created from the template" "the copy did not run"
  fi
  if [ -f "${ENV_FILE}" ]; then
    ok "the new file exists"
  else
    bad "the new file exists" "missing"
  fi
  if grep -q 'REPLACE-ME' "${ENV_FILE}" 2>/dev/null; then
    ok "the placeholder is present so it is noticed"
  else
    bad "the placeholder is present so it is noticed" "no placeholder"
  fi
  if cmp -s "${ENV_FILE}" "${APP_DIR}/deploy/dhoni-hobar-mojar-khela.env.example"; then
    ok "the created file matches the template exactly"
  else
    bad "the created file matches the template exactly" "differs"
  fi
fi

echo
echo "template sanity"

echo
echo "template sanity"
if grep -q '^STORE_DIR=/opt/dhoni-hobar-mojar-khela/data/rooms' "${DEPLOY}/dhoni-hobar-mojar-khela.env.example"; then
  ok "STORE_DIR sits inside the unit's writable path"
else
  bad "STORE_DIR sits inside the unit's writable path"
fi
if grep -q 'ReadWritePaths=/opt/dhoni-hobar-mojar-khela/data' "${DEPLOY}/dhoni-hobar-mojar-khela.service"; then
  ok "the unit allows writing there"
else
  bad "the unit allows writing there"
fi

# The port is read from the config file exactly once, before anything that
# needs it. (The read and its fallback are two lines; the read is one.)
PORT_READS=$(grep -c '^HEALTH_PORT=\$(grep' "${INSTALL_SH}")
if [ "${PORT_READS}" = "1" ]; then
  ok "the port is read from the config file exactly once"
else
  bad "the port is read from the config file exactly once" "found ${PORT_READS}"
fi

# A firewall on the machine itself would hide a working game behind a broken
# one, so the installer should deal with it when ufw is active.
if grep -q 'ufw allow' "${INSTALL_SH}"; then
  ok "the installer opens the port in ufw when present"
else
  bad "the installer opens the port in ufw when present"
fi

echo
echo "----------------------------------------------------------"
printf 'passed: %d   failed: %d\n' "${pass}" "${fail}"
echo "----------------------------------------------------------"
[ "${fail}" -eq 0 ] || exit 1
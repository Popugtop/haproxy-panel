#!/usr/bin/env bash
# Установщик агента PopugVPN на RU-мост. Отдаётся панелью:
#   curl -fsSL https://<панель>/install.sh | bash -s -- <токен>
# Повторный запуск без токена обновляет агент до версии, лежащей на панели.
#
# Что делает: ставит HAProxy (если его нет; нужен >= 2.8), скачивает агент с панели, проверяет
# контрольную сумму, регистрирует ноду по одноразовому токену, ставит systemd-юнит.
# Чего НЕ делает: не меняет существующий haproxy.cfg (конфиг ноды панель трогает только после вашего подтверждения).
set -euo pipefail

PANEL_URL="__PANEL_URL__"
MIN_HAPROXY="2.8"
BIN=/usr/local/bin/popug-agent
CONF_DIR=/etc/popug-agent
UNIT=/etc/systemd/system/popug-agent.service

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

TOKEN="${1:-}"
[ "$TOKEN" = "--update" ] && TOKEN=""

[ "$(id -u)" -eq 0 ] || die "запустите от root (sudo bash)"
command -v systemctl >/dev/null || die "нужен systemd"
case "$PANEL_URL" in https://*|http://*) ;; *) die "в скрипте не задан адрес панели; скачайте его с панели заново" ;; esac

case "$(uname -m)" in
  x86_64|amd64)  ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "архитектура $(uname -m) не поддерживается" ;;
esac

if [ -z "$TOKEN" ] && [ ! -f "$CONF_DIR/key" ]; then
  die "нода ещё не зарегистрирована: передайте токен из панели (curl … | bash -s -- <токен>)"
fi

OS_ID=""; OS_CODENAME=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-}"; OS_CODENAME="${VERSION_CODENAME:-}"
fi
IS_APT=0; command -v apt-get >/dev/null && IS_APT=1

ensure_tools() {
  command -v curl >/dev/null && command -v sha256sum >/dev/null && return
  [ "$IS_APT" = 1 ] || die "установите curl и coreutils вручную"
  say "устанавливаю curl"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates coreutils
}

haproxy_version() { haproxy -v 2>/dev/null | sed -n 's/^HA-\?Proxy version \([0-9][0-9.]*\).*/\1/p' | head -n1; }

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

install_haproxy() {
  [ "$IS_APT" = 1 ] || die "HAProxy не найден, а автоустановка поддерживает только Debian/Ubuntu. Установите HAProxy >= $MIN_HAPROXY и запустите скрипт снова."
  say "HAProxy не найден — устанавливаю"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  local cand
  cand="$(apt-cache policy haproxy | sed -n 's/^ *Candidate: *//p' | head -n1)"
  if [ -z "$cand" ] || [ "$cand" = "(none)" ] || ! dpkg --compare-versions "${cand#*:}" ge "$MIN_HAPROXY"; then
    say "в репозитории дистрибутива HAProxy ${cand:-нет} < $MIN_HAPROXY, подключаю haproxy.debian.net / PPA (ветка 3.0 LTS)"
    case "$OS_ID" in
      ubuntu)
        apt-get install -y -qq software-properties-common
        add-apt-repository -y ppa:vbernat/haproxy-3.0
        ;;
      debian)
        [ -n "$OS_CODENAME" ] || die "не удалось определить кодовое имя Debian"
        apt-get install -y -qq gnupg
        curl -fsSL https://haproxy.debian.net/bernat.debian.org.gpg | gpg --dearmor -o /usr/share/keyrings/haproxy.debian.net.gpg
        echo "deb [signed-by=/usr/share/keyrings/haproxy.debian.net.gpg] http://haproxy.debian.net ${OS_CODENAME}-backports-3.0 main" > /etc/apt/sources.list.d/haproxy.list
        ;;
      *) die "для $OS_ID нет готового репозитория HAProxy $MIN_HAPROXY+: поставьте его вручную" ;;
    esac
    apt-get update -qq
    apt-get install -y -qq "haproxy=3.0.*"
  else
    apt-get install -y -qq haproxy
  fi
  systemctl enable haproxy >/dev/null 2>&1 || true
}

ensure_tools

# Для банов клиентов нужны nftables (агент создаёт свою таблицу inet popug_bans и чужих правил не трогает) и желательно conntrack.
ensure_firewall_tools() {
  command -v nft >/dev/null && return
  if [ "$IS_APT" = 1 ]; then
    say "устанавливаю nftables (для банов клиентов)"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nftables conntrack >/dev/null || warn "не удалось установить nftables: баны клиентов работать не будут"
  else
    warn "nft не найден: установите nftables вручную, иначе баны клиентов работать не будут"
  fi
}
ensure_firewall_tools

if command -v haproxy >/dev/null; then
  HV="$(haproxy_version)"
  say "HAProxy ${HV:-?} уже установлен, конфиг не трогаю"
  if [ -n "$HV" ] && ! version_ge "$HV" "$MIN_HAPROXY"; then
    warn "версия $HV старше $MIN_HAPROXY: лимиты скорости (bwlim) на этой ноде будут недоступны. Обновите HAProxy отдельно."
  fi
else
  install_haproxy
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
say "скачиваю агент ($ARCH) с $PANEL_URL"
curl -fsSL "$PANEL_URL/dl/popug-agent-linux-$ARCH" -o "$TMP/popug-agent"
curl -fsSL "$PANEL_URL/dl/SHA256SUMS" -o "$TMP/SHA256SUMS"
want="$(awk -v f="popug-agent-linux-$ARCH" '$2 == f || $2 == "*"f {print $1}' "$TMP/SHA256SUMS")"
have="$(sha256sum "$TMP/popug-agent" | awk '{print $1}')"
[ -n "$want" ] && [ "$want" = "$have" ] || die "контрольная сумма агента не совпала (ожидали ${want:-?}, получили $have)"
curl -fsSL "$PANEL_URL/dl/popug-agent.service" -o "$TMP/popug-agent.service"
# Ключ подписи релизов закрепляется ОДИН раз, при первой установке (trust on first use) и дальше не перезаписывается:
# так панель не сможет подсунуть другой ключ. Нет ключа на панели — обновление по кнопке на этой ноде отключено.
if [ ! -s "$CONF_DIR/update.pub" ]; then
  if curl -fsSL "$PANEL_URL/dl/update.pub" -o "$TMP/update.pub" 2>/dev/null && [ -s "$TMP/update.pub" ]; then
    install -d -m 0755 "$CONF_DIR"; install -m 0644 "$TMP/update.pub" "$CONF_DIR/update.pub"
    say "закреплён ключ подписи релизов: обновления агента можно ставить кнопкой из панели"
  else
    warn "на панели нет ключа подписи релизов: агента придётся обновлять командой установки"
  fi
fi

install -m 0755 "$TMP/popug-agent" "$BIN.new"
mv -f "$BIN.new" "$BIN"
install -m 0644 "$TMP/popug-agent.service" "$UNIT"
install -d -m 0755 "$CONF_DIR"

if [ -n "$TOKEN" ]; then
  say "регистрирую ноду в панели"
  POPUG_TOKEN="$TOKEN" "$BIN" enroll --panel "$PANEL_URL"
fi

systemctl daemon-reload
systemctl enable popug-agent >/dev/null 2>&1
systemctl restart popug-agent
say "агент $("$BIN" version) запущен: systemctl status popug-agent, логи: journalctl -u popug-agent -f"

SOCK=/run/haproxy/admin.sock
if [ ! -S "$SOCK" ]; then
  warn "stats-сокет HAProxy $SOCK не найден. Агент будет работать, но метрики HAProxy появятся, когда в global будет строка:"
  warn "  stats socket $SOCK mode 660 level admin"
  warn "(панель добавит её сама при применении конфига; существующий конфиг установщик не меняет)"
fi

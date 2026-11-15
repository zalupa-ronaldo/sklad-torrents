#!/usr/bin/env bash
# Одна команда установки Склада на Mac и в Ubuntu WSL.
# Windows запускает scripts/one-command.ps1, а та при необходимости вызывает этот файл с --qbittorrent-only.
# Диск Z: не читается. Секреты, прошивки и ключи не скачиваются.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

refuse_z() {
  case "$1" in
    [Zz]:|[Zz]:\\*|[Zz]:/*|/mnt/[zZ]|/mnt/[zZ]/*)
      echo "Диск Z: не используется." >&2
      exit 1
      ;;
  esac
}

refuse_z "$ROOT"
refuse_z "$(pwd)"

wants() {
  needle="$1"
  shift
  for arg in "$@"; do
    if [ "$arg" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

is_wsl() {
  if [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${WSL_INTEROP:-}" ]; then
    return 0
  fi
  if [ -r /proc/version ] && grep -qi microsoft /proc/version; then
    return 0
  fi
  return 1
}

install_qbit() {
  if command -v qbittorrent-nox >/dev/null 2>&1; then
    echo "qbittorrent-nox уже установлен."
    return 0
  fi
  if ! is_wsl; then
    echo "Пакет qbittorrent-nox ставится в Ubuntu WSL. На этой системе шаг пропущен."
    return 0
  fi
  echo "Ставлю только пакет qbittorrent-nox, без рекомендуемых зависимостей."
  if ! sudo -n apt-get update; then
    echo "Нужен sudo без запроса пароля. В Ubuntu WSL выполните:" >&2
    echo "  sudo apt-get update && sudo apt-get install -y --no-install-recommends qbittorrent-nox" >&2
    return 2
  fi
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends qbittorrent-nox
}

if wants --help "$@" || wants -h "$@"; then
  if ! command -v node >/dev/null 2>&1; then
    echo "Mac и WSL: bash scripts/one-command.sh"
    echo "Windows: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\one-command.ps1"
    echo "Подробности: docs/ustanovka.md"
    exit 0
  fi
  node "$ROOT/scripts/one-command.mjs" --help
  exit 0
fi

if wants --qbittorrent-only "$@"; then
  if wants --check "$@"; then
    echo "Проверка: пакет qbittorrent-nox в WSL не ставится."
    exit 0
  fi
  install_qbit
  exit $?
fi

# Откат и самопроверка пакет не ставят. Иначе --rollback сначала поставил бы qbittorrent-nox.
if is_wsl && ! wants --check "$@" && ! wants --rollback "$@" && ! wants --self-test "$@"; then
  install_qbit
fi

if ! command -v node >/dev/null 2>&1; then
  if is_wsl; then
    echo "В WSL панель не ставится. Node.js 22 нужен на Mac и в Windows, не внутри WSL."
    exit 0
  fi
  echo "Нужен Node.js 22. Поставьте его с https://nodejs.org/ и снова выполните: bash scripts/one-command.sh" >&2
  exit 1
fi

major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$major" -lt 22 ]; then
  echo "Нужен Node.js 22 или новее. Сейчас: $(node -v)" >&2
  exit 1
fi

if is_wsl; then
  exec node "$ROOT/scripts/one-command.mjs" "$@" --role wsl
fi

exec node "$ROOT/scripts/one-command.mjs" "$@"

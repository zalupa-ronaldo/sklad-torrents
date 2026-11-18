# Установка одной командой

Склад ставится одной командой на Mac и одной командой на Windows. Команда Windows сама заходит в Ubuntu WSL и ставит там только пакет `qbittorrent-nox`. Повтор безопасен: уже сделанные шаги пропускаются.

Команда не меняет поведение панели. Она ставит зависимости Node и, в WSL, один системный пакет.

## Чего команда не делает

- Не открывает, не сканирует, не монтирует и не логирует диск `Z:`. Если сам репозиторий лежит на `Z:`, команда сразу останавливается.
- Не удаляет файлы, раздачи и каталог `data/` с хостами, заданиями и паролями Web UI.
- Не скачивает прошивки, BIOS, ключи, HandBrake, CompactGUI и DiscImageStudio. Эти программы ставятся отдельно, с их официальных страниц, когда они нужны. Бинарники в репозиторий не кладутся.
- Не пишет пароли и `.env` в git. Служебная отметка `data/one-command.json` в git не входит.
- Не меняет брандмауэр и не настраивает проброс портов между Mac и WSL.
- Не запускает панель, qBittorrent и агентов. После установки их включают командами ниже.

## Что уже должно быть

- Node.js 22 на Mac.
- Node.js 22 для Windows. Это не `node` из WSL: агент полки Windows читает диски только процессом `win32`.
- На ПК — Ubuntu в WSL. Пользователь дистрибутива может быть любым, пакет ставится через `sudo`.
- qBittorrent на Mac, HandBrake и DiscImageStudio — по желанию, своими установщиками. `compact.exe` уже входит в Windows.

## Mac

Из корня репозитория, там, где лежит `package.json`:

```bash
bash scripts/one-command.sh
```

Проверка без установки и без сети пакетов:

```bash
bash scripts/one-command.sh --check
```

Команда выполняет `npm ci` и смотрит, есть ли в `PATH` `HandBrakeCLI` и `qbittorrent`. Если их нет, установка панели всё равно завершается. Диск она не обходит.

Панель:

```bash
npm run dev
```

Адрес: http://127.0.0.1:4317 — обзор коллекции (диски, каталог, копирование с SHA-256, очередь, раздачи, устройства и детали файла). Прежний интерфейс: http://127.0.0.1:4317/legacy. Сценарии прототипа только в `npm run dev`: http://127.0.0.1:4317/?demo=1. Собранный образ и `next start` этот параметр игнорируют. Ход AV1 на ПК только читается через агент `192.168.0.16:4730`, `GET /v1/av1-status`. Кодирование этой кнопкой не запускается. В простое панель не опрашивает диски и очередь по таймеру. Данные читаются при открытии, при переходе в раздел и по событию очереди. Скрытая вкладка запросы не шлёт. События очереди сжимаются до одного обновления за 2 секунды. Агент Mac не вызывает `diskutil info -all` по таймеру: новый том описывается один раз, появление тома приходит от DiskArbitration, изменения файлов — от FSEvents. Игровой режим описан в [game-mode.md](game-mode.md).

Агент полки на этом же Mac, второе окно терминала:

```bash
node --import ./agents/register.mjs agents/mac-agent/drive.mts --port 4371
```

Панель, которая ходит в этот агент:

```bash
SKLAD_DRIVE_MODE=agents SKLAD_MAC_AGENT_URL=http://127.0.0.1:4371 npm run dev
```

Без этих переменных панель остаётся в демо и диски машины не читает.

Панель можно запустить в Docker, образ `linux/arm64`. Агент дисков при этом остаётся командой выше, на хосте. Из контейнера панель ходит на `http://host.docker.internal:4371`. Данные — bind-mount `/Users/uzer/.local/sklad-data-clean`, не копия volume. Агент ПК: `http://192.168.0.16:4730` (`GET /v1/channel`). qBittorrent этого ПК на `192.168.0.16:8080` и `192.168.0.16:18080` доступен из контейнера, эти порты наружу не публикуются.

```bash
docker compose up -d --build
```

Адрес панели тот же: http://127.0.0.1:4317. Прежний интерфейс: http://127.0.0.1:4317/legacy. Остановка: `docker compose down`. Пока контейнер запущен, второй `npm run dev` на порту `4317` не поднимайте.

## Windows и WSL

PowerShell, корень репозитория, не диск `Z:`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\one-command.ps1
```

Проверка без установки:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\one-command.ps1 --check
```

Команда делает три вещи:

1. `npm ci` сборкой Windows.
2. Проверяет два заранее известных пути и больше ничего на дисках не открывает: `C:\Windows\System32\compact.exe` и `C:\Program Files\HandBrake\HandBrakeCLI.exe`.
3. Вызывает Ubuntu WSL: `wsl.exe -e bash scripts/one-command.sh --qbittorrent-only`. Там ставится только пакет `qbittorrent-nox`, если его ещё нет и `sudo -n` не спрашивает пароль.

Если `sudo` просит пароль, в терминале будет строка, её нужно выполнить уже внутри Ubuntu и затем повторить команду Windows:

```bash
sudo apt-get update && sudo apt-get install -y --no-install-recommends qbittorrent-nox
```

Та же установка из уже открытого Ubuntu, без Windows-части:

```bash
bash scripts/one-command.sh
```

В WSL `npm ci` не запускается. Если репозиторий лежит на `/mnt/c` или другом диске Windows, общий `node_modules` нельзя собирать из Linux и из Windows сразу. Зависимости панели ставятся командой Mac или командой Windows.

### Что запустить на ПК

Агент заданий в макете. HandBrake и `compact.exe` не вызываются, пока макет не выключен:

```bat
npm run pc-agent
```

Проверка: http://127.0.0.1:4730/v1/health

Настоящие программы — только на Windows и только когда файлы уже лежат по путям:

```bat
set SKLAD_PC_AGENT_MOCK=0
set SKLAD_PC_AGENT_HOST=0.0.0.0
node agents\pc-agent\server.mjs
```

Агент полки, именно Windows Node:

```bat
node --import ./agents/register.mjs agents/pc-agent/drive.mts --port 4372
```

`node` из Ubuntu этот агент не заменяет: внутри WSL платформа `linux`, и сборщик дисков ответит, что он запущен не на Windows.

qBittorrent в Ubuntu, из каталога, где удобно смотреть вывод:

```bash
qbittorrent-nox
```

При первом запуске программа сама печатает временный пароль Web UI в этот терминал. Задайте свой пароль в Web UI. В репозиторий, в `data/` и в чат его не копируйте. Порт по умолчанию — `8080`. Если пароль уже был задан раньше, новой строки с паролем не будет.

Панель на самом ПК, если она запущена не на Mac:

```bat
npm run dev
```

http://127.0.0.1:4317

С Mac панель ходит на IPv4 этого ПК. Проброс на случай смены адреса WSL этой командой не включается.

## Как понять, что установка прошла

Mac:

```bash
node -v
test -d node_modules/next && echo "зависимости на месте"
npm test
```

В браузере открывается http://127.0.0.1:4317

Windows, в `cmd` из корня репозитория:

```bat
node -v
node -p process.platform
```

Вторая строка должна быть `win32`. `linux` значит, что в `PATH` попал Node из WSL: для агента он не подходит.

```bat
dir node_modules\next
```

Ubuntu WSL:

```bash
command -v qbittorrent-nox
qbittorrent-nox --version
```

Служебный файл `data/one-command.json` появляется после команды без `--check`. В нём роль, версия Node и список шагов. Паролей там нет. В git он не входит.

## Откат

Откат не удаляет хосты, задания и остальные файлы `data/`. Диски не читает и не меняет. Пакеты системы не снимает.

Mac и WSL:

```bash
bash scripts/one-command.sh --rollback
```

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\one-command.ps1 --rollback
```

Так снимается только `data/one-command.json`. Каталог `node_modules` остаётся. Удалить и его:

```bash
bash scripts/one-command.sh --rollback --purge-modules
```

На Windows то же с `-File scripts\one-command.ps1 --rollback --purge-modules`.

Снять `qbittorrent-nox`, если он больше не нужен, вручную в Ubuntu:

```bash
sudo apt-get remove qbittorrent-nox
```

Node.js, HandBrake и qBittorrent на Mac остаются: команда их не ставила и не удаляет.

Остановить панель и агентов — закрыть их терминалы или завершить процессы `node`, которые вы сами запустили. Откат процессы не ищет и чужие программы не убивает.

## Если команда остановилась

- `Нужен Node.js 22` — поставьте Node.js 22 с https://nodejs.org/ и выполните ту же команду ещё раз.
- `Сейчас node отвечает платформой linux` — в Windows PowerShell в `PATH` стоит Node из WSL. Откройте обычный терминал Windows, где `node -p process.platform` печатает `win32`.
- `Диск Z: не используется` — перенесите репозиторий с `Z:` на другой диск и запустите команду оттуда.
- `Нужен sudo` — выполните напечатанную строку `apt-get` в Ubuntu и повторите команду. Пароль в скрипт вводить не нужно: `sudo` спросит его сам в вашем терминале.
- `wsl.exe не найден` — установите Ubuntu WSL и повторите команду Windows. Зависимости панели на Windows к этому моменту уже могут быть на месте; повтор их не ломает.

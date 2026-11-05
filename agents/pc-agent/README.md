# Агент Склада на Windows

Маленький локальный HTTP-сервис. Панель Склад чаще запущена на Mac и не может сама вызвать `HandBrakeCLI.exe` или `compact.exe` на ПК. Агент принимает те же задания: перекодирование, перенос папки, сжатие NTFS.

Прокси и VLESS не нужны. Это обычный HTTP по домашней сети.

## Запуск

На ПК, из каталога репозитория (Node.js 22):

```bash
node agents/pc-agent/server.mjs
```

По умолчанию агент слушает только `127.0.0.1:4730` и работает в макете (`mock`): очередь, прогресс и команды есть, программы не запускаются. В stdout будет строка `sklad-pc-agent 4730`.

Проверка: откройте `http://127.0.0.1:4730/v1/health`. В ответе `mock: true`, пути HandBrake и `compact.exe`, и найдены ли файлы.

Чтобы к агенту ходил Mac в той же сети:

```bash
set SKLAD_PC_AGENT_HOST=0.0.0.0
set SKLAD_PC_AGENT_MOCK=1
node agents/pc-agent/server.mjs
```

В брандмауэре разрешите порт `4730` только в частной сети. В Складе, «Медиа и игры → Настройки», у хоста «Windows PC» укажите `http://192.168.1.50:4730` (свой IPv4 из `ipconfig`).

Пока в Складе включён демо-режим, панель не звонит агенту и крутит очередь у себя. Демо выключают, когда агент уже отвечает.

## Настоящие программы

Только на Windows и только осознанно:

```bash
set SKLAD_PC_AGENT_MOCK=0
set HANDBRAKE_CLI=C:\Program Files\HandBrake\HandBrakeCLI.exe
set COMPACT_EXE=C:\Windows\System32\compact.exe
node agents/pc-agent/server.mjs
```

- HandBrake не входит в агент. Нужен установленный `HandBrakeCLI.exe`. Flatpak на Windows не используется.
- Сжатие — это `compact.exe /C /EXE:LZX` (ещё XPRESS16K, XPRESS8K, XPRESS4K). CompactGUI можно поставить отдельно как окно, агент его не вызывает.
- Пути вроде `/Volumes/vault` отклоняются. `compact` только для буквы диска или UNC.
- Перенос: копирование, потом проверка. Исходная папка удаляется только после проверки и отдельного подтверждения из Склада.

## Протокол

`GET /v1/health`

`POST /v1/jobs` — тело `{ kind, title, handbrakePath, inputPath, outputPath, preset }` или `{ kind: "compress", folderPath, algorithm, compactPath }` или `{ kind: "move", sourcePath, destinationPath }`.

`POST /v1/jobs/:id/tick` — один шаг прогресса.

`POST /v1/jobs/:id/confirm` — `{ "deleteSource": true }` только если копия уже `verified`. Иначе `400`, и флаг удаления остаётся ложным.

Ответ с ошибкой: `{ "error": "…" }`.

## Индекс NTFS (MFT и USN)

Те же процесс и порт. Панель «Медиа и игры» для тома Windows вызывает:

- `POST /v1/index/build` — `{ "volume": "D:", "filesystem": "ntfs", "host": "Windows PC", "walkRoot": "…" }`
- `GET /v1/index/search?q=Hades&volume=D:`
- `GET /v1/index/status`
- `GET /v1/index/health` — `elevated` и платформа

Решение принимает агент, а не браузер. Если процесс повышен и том NTFS, полная сборка читает MFT (`FSCTL_ENUM_USN_DATA` по `\\.\D:`), следующее обновление — журнал USN (`FSCTL_READ_USN_JOURNAL`). Без прав администратора или если том не NTFS — обычный обход папок, сырой том не открывается.

APFS и любой путь `/Volumes/…` в этот код не попадают. Их обходит сам Склад на Mac.

Обычный запуск — как в разделе «Запуск» выше: обход папок.

Запуск с MFT, в консоли «от имени администратора»:

```bat
cd /d C:\path\to\sklad
npm run pc-agent
```

В `/v1/index/health` поле `elevated` станет `true`. Первая сборка `D:` ответит источником `mft`, повторная — `usn`.

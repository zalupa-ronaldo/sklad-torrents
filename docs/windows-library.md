# Библиотека Windows-игр

Экран `/games` читает `GET /api/windows-library` один раз при открытии и после действия человека. Таймера нет. `diskutil` отсюда не запускается.

Демо-карточка Hades появляется только при `?demo=1` и на сервер не отправляется.

## Индекс

Том приходит событием, не опросом.

- Windows NTFS: одно чтение MFT на том (`read-mft`). Дальше `FSCTL_QUERY_USN_JOURNAL` (`0x900F4`) и `FSCTL_READ_USN_JOURNAL` (`0x900BB`). Повторное MFT отклоняется.
- Журнал потерян, если сменился `UsnJournalID` или `LowestValidUsn` ушёл дальше сохранённого курсора. Тогда один обход, MFT заново не читается. Запись USN без известного родителя не получает выдуманный путь.
- exFAT и FAT: один обход при подключении. Второй раз обход не принимается.
- `E:`, `Z:` и виртуальный `F:` не индексируются.
- Mac, если событие всё же пришло: `diskutil info` один раз на новый том, дальше FSEvents. Полный обход только при первом подключении или дыре в `lastEventId`. Повторный `diskutil` не запрашивается.

`POST` с `action: "advance"` отвечает отказом. Перенос выполняет `advanceWindowsLibrary` на переданной файловой карте. В тестах это память, не диск. `compact.exe` не запускается.

## Очередь

Сжатие ставится в очередь библиотеки. По умолчанию XPRESS8K. Если в переданной базе CompactGUI есть свежая строка с положительной экономией, берётся этот алгоритм. Файл `database.json` в репозиторий не кладётся. Неизвестная экономия не считается нулём.

«Играю сейчас» и возврат в архив требуют `confirm: true` и список процессов. Процесс внутри корня — отказ, файлы не меняются. После копии сравнивается SHA-256. Несовпадение снимает только копию. Источник удаляется после совпадения. Для Steam правится `libraryfolders.vdf` и `appmanifest`: `StateFlags` 4, `BytesToDownload` 0, `FullValidateAfterNextUpdate` 0. Чужое назначение без метки этой игры не перезаписывается.

Быстрый SSD задаётся настройкой `serial`, `uuid`, `root`. Путь в коде не выбран.

Обложка: кэш, иначе адрес CDN Steam по AppID, иначе имя. SteamGridDB только как ключ кэша. Запрос списка ничего не скачивает. Ключ пользователя не требуется и в код не записан.

## Чужой код

Фрагменты ab-av1, ntfs-reader, usn-journal-rs, objc2-disk-arbitration, czkawka, fclones, Playnite, Steam Library Manager, andygrunwald/vdf, xPaw/SteamAppInfo, Ludusavi, Scrutiny, scttcper/qbittorrent и node-steamgriddb в этот модуль не копировались. CompactGUI, Av1an, Jellyfin, *arr, RomM, Unmanic, rmlint, smartmontools и Syncthing не вендорятся. Tdarr, FileFlows и leovp/steamfiles не используются. Своя реализация USN и VDF написана здесь. В `THIRD_PARTY_NOTICES.md` добавлять нечего: файл ведёт PR #21.

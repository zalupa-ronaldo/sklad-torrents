import { FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_USN_JOURNAL, usnJournalLost } from "@/lib/windows-library/usn-journal";
import type { FilesystemKind, IndexAction, LibraryEvent, LibraryOs, VolumeCursor, VolumeIdentity, WalkReason } from "@/lib/windows-library/types";

const FORBIDDEN_LETTERS = new Set(["E", "Z", "F"]);

export function emptyCursor(identity: VolumeIdentity): VolumeCursor {
  return {
    serial: identity.serial,
    uuid: identity.uuid,
    os: identity.os,
    filesystem: identity.filesystem,
    letter: identity.letter,
    mount: identity.mount,
    attached: false,
    mftIndexed: false,
    walked: false,
    journalId: null,
    nextUsn: null,
    lastEventId: null,
    diskutilCached: false,
    mftTicket: false,
    usnTicket: false,
    walkTicket: null,
    diskutilTicket: false,
    awaitingJournalPin: false,
    pendingJournalId: null,
    pendingNextUsn: null,
    pendingEventId: null,
  };
}

export function volumeKey(volume: Pick<VolumeCursor, "serial" | "uuid">): string {
  return `${volume.serial.trim()}|${volume.uuid.trim().toLowerCase()}`;
}

/**
 * What one volume event is allowed to do. There is no timer here.
 * NTFS gets a single MFT index, then USN. A directory walk is issued only for
 * the first attach of a non-NTFS volume, a lost USN journal, or a dropped
 * FSEvents history. exFAT and FAT are not walked again.
 */
export function decideVolumeEvent(cursor: VolumeCursor | null, event: LibraryEvent): { actions: IndexAction[]; cursor: VolumeCursor | null } {
  if (event.type === "poll") {
    return { actions: [{ type: "refuse", reason: "Опрос по таймеру запрещён. Том приходит событием." }], cursor };
  }
  if (event.type === "journal-info") return onJournal(cursor, event);
  if (event.type === "fsevent") return onFsEvent(cursor, event);
  if (event.type === "wmi" && event.eventType === 1) return onConfig(cursor, event.identity);
  const kind = arrivalKind(event);
  if (!kind) return { actions: [{ type: "ignore", reason: "Событие тома не про появление и не про отключение." }], cursor };
  const identity = eventIdentity(event);
  if (!identity) return { actions: [{ type: "refuse", reason: "У события нет тома." }], cursor };
  const forbidden = forbiddenReason(identity);
  if (forbidden) return { actions: [{ type: "refuse", reason: forbidden }], cursor };
  if (kind === "removal") return detach(cursor, identity);
  if (event.type === "mac-appear" || identity.os === "darwin") return attachMac(cursor, identity);
  return attachWindows(cursor, identity);
}

export function noteMft(cursor: VolumeCursor): VolumeCursor {
  if (!cursor.mftTicket) throw new Error("Снимок MFT не запрошен. Повторное чтение таблицы не выполняется.");
  return { ...cursor, mftIndexed: true, mftTicket: false, awaitingJournalPin: true };
}

export function noteWalk(cursor: VolumeCursor): VolumeCursor {
  if (!cursor.walkTicket) throw new Error("Обход не запрошен. Повторный обход не выполняется.");
  return {
    ...cursor,
    walked: true,
    walkTicket: null,
    journalId: cursor.pendingJournalId ?? cursor.journalId,
    nextUsn: cursor.pendingNextUsn ?? cursor.nextUsn,
    lastEventId: cursor.pendingEventId ?? cursor.lastEventId,
    pendingJournalId: null,
    pendingNextUsn: null,
    pendingEventId: null,
    awaitingJournalPin: false,
  };
}

export function noteUsn(cursor: VolumeCursor, nextUsn: string): VolumeCursor {
  if (!cursor.usnTicket) throw new Error("Чтение USN не запрошено.");
  return { ...cursor, usnTicket: false, nextUsn };
}

export function noteDiskutil(cursor: VolumeCursor): VolumeCursor {
  if (!cursor.diskutilTicket && cursor.diskutilCached) return cursor;
  if (!cursor.diskutilTicket) throw new Error("diskutil info для этого тома не запрашивался.");
  return { ...cursor, diskutilTicket: false, diskutilCached: true };
}

function onJournal(cursor: VolumeCursor | null, event: Extract<LibraryEvent, { type: "journal-info" }>): { actions: IndexAction[]; cursor: VolumeCursor | null } {
  if (!cursor || !cursor.attached || volumeKey(cursor) !== volumeKey(event.identity)) {
    return { actions: [{ type: "refuse", reason: "Журнал USN пришёл для тома, который не подключён." }], cursor };
  }
  if (!cursor.mftIndexed && !cursor.walked) {
    return { actions: [{ type: "refuse", reason: "Сначала один индекс MFT. Журнал USN его не заменяет." }], cursor };
  }
  if (cursor.awaitingJournalPin || !cursor.journalId || !cursor.nextUsn) {
    return {
      actions: [{ type: "ignore", reason: "Курсор журнала записан. Старые записи USN не читаются: индекс уже снят." }],
      cursor: {
        ...cursor,
        awaitingJournalPin: false,
        journalId: event.journalId,
        nextUsn: event.nextUsn,
      },
    };
  }
  if (cursor.walkTicket) {
    return { actions: [{ type: "ignore", reason: "Обход уже назначен." }], cursor };
  }
  const lost = usnJournalLost(
    { journalId: cursor.journalId, nextUsn: cursor.nextUsn },
    { journalId: event.journalId, lowestValidUsn: event.lowestValidUsn, nextUsn: event.nextUsn },
  );
  if (lost) {
    return {
      actions: [{ type: "walk-once", reason: "journal-lost" }],
      cursor: { ...cursor, walkTicket: "journal-lost", pendingJournalId: event.journalId, pendingNextUsn: event.nextUsn },
    };
  }
  return {
    actions: [{
      type: "read-usn",
      ioctl: FSCTL_READ_USN_JOURNAL,
      journalId: cursor.journalId,
      startUsn: cursor.nextUsn,
      reason: "Журнал USN продолжается. Таблица MFT заново не читается.",
    }],
    cursor: { ...cursor, usnTicket: true },
  };
}

function onFsEvent(cursor: VolumeCursor | null, event: Extract<LibraryEvent, { type: "fsevent" }>): { actions: IndexAction[]; cursor: VolumeCursor | null } {
  if (!cursor || !cursor.attached || volumeKey(cursor) !== volumeKey(event.identity)) {
    return { actions: [{ type: "refuse", reason: "FSEvents пришли для тома, который DiskArbitration ещё не подключил." }], cursor };
  }
  if (!/^\d+$/.test(event.eventId)) {
    return { actions: [{ type: "refuse", reason: "lastEventId должен быть числом." }], cursor };
  }
  if (cursor.walkTicket) return { actions: [{ type: "ignore", reason: "Обход уже назначен." }], cursor };
  if (cursor.lastEventId && BigInt(event.eventId) <= BigInt(cursor.lastEventId)) {
    return { actions: [{ type: "ignore", reason: "Это FSEvents уже записано. Обход не запускается." }], cursor };
  }
  if (event.historyDropped || eventIdGap(cursor.lastEventId, event.eventId)) {
    return {
      actions: [{ type: "walk-once", reason: "history-dropped" }],
      cursor: { ...cursor, walkTicket: "history-dropped", pendingEventId: event.eventId },
    };
  }
  return {
    actions: [{ type: "ignore", reason: "FSEvents без дыры в истории. Обход не запускается." }],
    cursor: { ...cursor, lastEventId: event.eventId },
  };
}

function attachWindows(cursor: VolumeCursor | null, identity: VolumeIdentity): { actions: IndexAction[]; cursor: VolumeCursor | null } {
  const next = merge(cursor, identity, true);
  if (forbiddenReason(identity)) return { actions: [{ type: "refuse", reason: forbiddenReason(identity)! }], cursor };
  if (next.filesystem === "ntfs") {
    if (!next.mftIndexed) {
      if (next.mftTicket) return { actions: [{ type: "ignore", reason: "Чтение MFT уже назначено." }], cursor: next };
      return {
        actions: [{ type: "read-mft", reason: "Первое подключение NTFS: один индекс MFT, без обхода папок." }],
        cursor: { ...next, mftTicket: true },
      };
    }
    if (next.walkTicket) return { actions: [{ type: "ignore", reason: "Обход уже назначен." }], cursor: next };
    return {
      actions: [{ type: "query-usn", ioctl: FSCTL_QUERY_USN_JOURNAL, reason: "Индекс MFT уже есть. Дальше только журнал USN." }],
      cursor: next,
    };
  }
  return walkFat(next);
}

function attachMac(cursor: VolumeCursor | null, identity: VolumeIdentity): { actions: IndexAction[]; cursor: VolumeCursor | null } {
  const next = merge(cursor, { ...identity, os: "darwin" }, true);
  const actions: IndexAction[] = [];
  let current = next;
  if (!current.diskutilCached && !current.diskutilTicket) {
    actions.push({ type: "diskutil-info-once", reason: "diskutil info один раз для нового тома. Повтор из кэша не вызывается." });
    current = { ...current, diskutilTicket: true };
  }
  if (!current.walked && !current.walkTicket) {
    actions.push({ type: "walk-once", reason: "first-attach" });
    current = { ...current, walkTicket: "first-attach" };
  }
  if (actions.length === 0) {
    actions.push({ type: "ignore", reason: "Том Mac уже описан. diskutil info повторно не вызывается, обход не запускается." });
  }
  return { actions, cursor: current };
}

function walkFat(cursor: VolumeCursor): { actions: IndexAction[]; cursor: VolumeCursor } {
  if (cursor.walked) {
    return { actions: [{ type: "ignore", reason: "exFAT и FAT обходятся один раз при подключении. Повторного обхода нет." }], cursor };
  }
  if (cursor.walkTicket) return { actions: [{ type: "ignore", reason: "Обход уже назначен." }], cursor };
  const reason: WalkReason = cursor.filesystem === "exfat" || cursor.filesystem === "fat" ? "fat" : "first-attach";
  return {
    actions: [{ type: "walk-once", reason }],
    cursor: { ...cursor, walkTicket: reason },
  };
}

function onConfig(cursor: VolumeCursor | null, identity: VolumeIdentity): { actions: IndexAction[]; cursor: VolumeCursor | null } {
  if (!cursor || !cursor.attached || volumeKey(cursor) !== volumeKey(identity)) {
    return { actions: [{ type: "ignore", reason: "Конфигурация тома не запускает обход." }], cursor };
  }
  if (cursor.filesystem === "ntfs" && cursor.mftIndexed && !cursor.walkTicket) {
    return {
      actions: [{ type: "query-usn", ioctl: FSCTL_QUERY_USN_JOURNAL, reason: "Конфигурация тома читает журнал USN, не таблицу MFT и не дерево папок." }],
      cursor,
    };
  }
  return { actions: [{ type: "ignore", reason: "Конфигурация тома не запускает обход." }], cursor };
}

function detach(cursor: VolumeCursor | null, identity: VolumeIdentity): { actions: IndexAction[]; cursor: VolumeCursor | null } {
  if (!cursor || volumeKey(cursor) !== volumeKey(identity)) {
    return { actions: [{ type: "ignore", reason: "Отключён том, которого нет в индексе." }], cursor };
  }
  return {
    actions: [{ type: "detach", reason: "Том отключён событием. Индекс сохранён, обход не запускается." }],
    cursor: {
      ...cursor,
      attached: false,
      letter: identity.letter ?? cursor.letter,
      mount: identity.mount ?? cursor.mount,
      mftTicket: false,
      usnTicket: false,
      walkTicket: null,
      diskutilTicket: false,
      awaitingJournalPin: false,
    },
  };
}

function merge(cursor: VolumeCursor | null, identity: VolumeIdentity, attached: boolean): VolumeCursor {
  const base = cursor && volumeKey(cursor) === volumeKey(identity) ? cursor : emptyCursor(identity);
  return {
    ...base,
    os: identity.os,
    filesystem: identity.filesystem,
    letter: identity.letter,
    mount: identity.mount,
    attached,
  };
}

function arrivalKind(event: LibraryEvent): "arrival" | "removal" | null {
  if (event.type === "mac-appear") return "arrival";
  if (event.type === "mac-disappear") return "removal";
  if (event.type === "wmi") {
    if (event.eventType === 2) return "arrival";
    if (event.eventType === 3) return "removal";
    return null;
  }
  if (event.type === "dbt") {
    if (event.code === 0x8000) return "arrival";
    if (event.code === 0x8004) return "removal";
    return null;
  }
  return null;
}

function eventIdentity(event: LibraryEvent): VolumeIdentity | null {
  if (event.type === "poll" || event.type === "journal-info" || event.type === "fsevent") return null;
  return event.identity;
}

function forbiddenReason(identity: VolumeIdentity): string | null {
  if (!identity.serial.trim() || !identity.uuid.trim()) return "Нужны серийный номер и UUID тома. Буква диска томом не является.";
  const letter = identity.letter?.toUpperCase() ?? "";
  if (identity.os === "win32" && FORBIDDEN_LETTERS.has(letter)) {
    if (letter === "F") return "F: — виртуальный диск Alcohol. В библиотеку игр он не берётся.";
    return `${letter}: живьём не открывается.`;
  }
  return null;
}

function eventIdGap(saved: string | null, next: string): boolean {
  if (!saved) return false;
  return BigInt(next) > BigInt(saved) + 1n;
}

export function filesystemKind(value: string): FilesystemKind {
  const text = value.trim().toLowerCase();
  if (text === "ntfs") return "ntfs";
  if (text === "exfat") return "exfat";
  if (text === "fat" || text === "fat16" || text === "fat32" || text === "vfat") return "fat";
  if (text === "apfs") return "apfs";
  return "unknown";
}

export function libraryOs(value: string): LibraryOs | null {
  if (value === "win32" || value === "darwin") return value;
  return null;
}

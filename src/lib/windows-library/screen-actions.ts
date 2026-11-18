/** Requests the games screen is allowed to send. Demo cards never reach this. */

export function moveRequest(input: {
  id: string;
  kind: "play" | "return";
  confirmed: boolean;
  notRunning: boolean;
}): { ok: true; body: { action: "play" | "return"; id: string; confirm: true; processes: [] } } | { ok: false; reason: string } {
  if (!input.confirmed) return { ok: false, reason: "Сначала подтвердите действие. Без этого файлы не меняются." };
  if (!input.notRunning) return { ok: false, reason: "Отметьте, что игра не запущена. Без этого файлы не трогаем." };
  return { ok: true, body: { action: input.kind, id: input.id, confirm: true, processes: [] } };
}

export function compressRequest(id: string): { action: "compress"; id: string } {
  return { action: "compress", id };
}

export function settingsRequest(fastSsd: { serial: string; uuid: string; root: string } | null) {
  return { action: "settings" as const, fastSsd };
}

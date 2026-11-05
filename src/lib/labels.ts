import type { HostOs, NormalizedState } from "@/lib/qbittorrent/types";

export function stateLabel(state: NormalizedState, rawState: string): string {
  if (state === "paused" && rawState.endsWith("UP")) return "На паузе · была раздача";
  switch (state) {
    case "downloading":
      return "Загрузка";
    case "metadata":
      return "Метаданные";
    case "stalled":
      return "Нет пиров";
    case "paused":
      return "На паузе";
    case "queued":
      return "В очереди";
    case "seeding":
      return "Раздача";
    case "checking":
      return "Проверка";
    case "moving":
      return "Перемещение";
    case "error":
      return "Ошибка";
    case "missing":
      return "Нет файлов";
    default:
      return rawState || "Неизвестно";
  }
}

export function priorityLabel(priority: number): string {
  if (priority <= 0) return "Не скачивать";
  if (priority === 1) return "Обычный";
  if (priority < 6) return "Повышенный";
  if (priority === 6) return "Высокий";
  return "Максимальный";
}

export function osLabel(os: HostOs): string {
  return os === "win32" ? "Windows" : "macOS";
}

export function stateTone(state: NormalizedState): "download" | "seed" | "warn" | "problem" | "neutral" {
  switch (state) {
    case "downloading":
    case "metadata":
    case "checking":
    case "moving":
      return "download";
    case "seeding":
      return "seed";
    case "stalled":
    case "paused":
    case "queued":
      return "warn";
    case "error":
    case "missing":
      return "problem";
    default:
      return "neutral";
  }
}

export function pluralTorrents(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} раздача`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} раздачи`;
  return `${count} раздач`;
}

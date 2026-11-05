import type { BurnedDisc, OpticalDrive, SearchHit } from "@/lib/optical/media";

export function discIsOffline(disc: BurnedDisc, drives: OpticalDrive[]): boolean {
  if (!disc.id) return true;
  return !drives.some((drive) => drive.volumeUuid !== null && drive.volumeUuid === disc.id);
}

export function lookupMessage(input: {
  fileName: string;
  label: string;
  locationNote: string;
  source: BurnedDisc["source"];
  offline: boolean;
}): string {
  const place = input.locationNote.trim() || "место не указано";
  const where = input.offline ? "Диск не в приводе." : "Диск сейчас в приводе.";
  const demo = input.source === "mock" ? " Это демо-запись, не настоящий диск." : "";
  return `Файл «${input.fileName}» на диске «${input.label}», ${place}. ${where}${demo}`;
}

export function searchBurnedFiles(discs: BurnedDisc[], query: string, drives: OpticalDrive[] = []): SearchHit[] {
  const needle = query.trim().toLocaleLowerCase("ru");
  if (!needle) return [];
  const hits: SearchHit[] = [];
  for (const disc of discs) {
    const offline = discIsOffline(disc, drives);
    for (const file of disc.files) {
      const hay = `${file.name} ${file.path}`.toLocaleLowerCase("ru");
      if (!hay.includes(needle)) continue;
      hits.push({
        discId: disc.id,
        label: disc.label,
        locationNote: disc.locationNote,
        fileName: file.name,
        filePath: file.path,
        source: disc.source,
        offline,
        message: lookupMessage({
          fileName: file.name,
          label: disc.label,
          locationNote: disc.locationNote,
          source: disc.source,
          offline,
        }),
      });
    }
  }
  return hits;
}

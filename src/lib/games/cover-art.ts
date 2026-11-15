import { PLATFORM_LABEL, type ShelfPlatform } from "@/lib/games/platforms";

const TONE: Record<ShelfPlatform, [string, string]> = {
  windows: ["#3f3f46", "#18181b"],
  macos: ["#075985", "#0f172a"],
  switch: ["#991b1b", "#18181b"],
  psp: ["#3730a3", "#18181b"],
  ps2: ["#6d28d9", "#18181b"],
  ps4: ["#1d4ed8", "#18181b"],
};

/** A cover drawn locally from the title. Nothing is fetched. */
export function generatedCover(input: { name: string; platform: ShelfPlatform; year: number | null }): string {
  const [from, to] = TONE[input.platform];
  const title = escapeXml(input.name).slice(0, 42);
  const meta = escapeXml([PLATFORM_LABEL[input.platform], input.year ? String(input.year) : ""].filter(Boolean).join(" · "));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="300" height="450" fill="url(#g)"/><text x="24" y="300" fill="#fff" font-family="sans-serif" font-size="28" font-weight="700">${title}</text><text x="24" y="340" fill="#e4e4e7" font-family="sans-serif" font-size="16">${meta}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

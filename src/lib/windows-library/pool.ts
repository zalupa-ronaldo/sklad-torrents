/** Whether a reported process sits inside a game root. The copy itself is not done here. */

export function runningInside(root: string, processes: readonly { path: string }[]): boolean {
  const base = norm(root);
  if (!base) return false;
  return processes.some((process) => {
    const file = norm(process.path);
    return file === base || file.startsWith(`${base}/`);
  });
}

function norm(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

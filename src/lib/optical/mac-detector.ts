/**
 * The Mac is a remote control. The DVD recorder is attached to the Windows PC,
 * so this detector never inspects local drives and never claims a burner.
 * `localListing` is accepted only so tests can prove a drutil-style listing is ignored.
 */
export interface MacDetectorReport {
  recorders: [];
  lookedForLocalDrive: false;
  message: string;
}

export function detectMacRecorders(localListing?: string): MacDetectorReport {
  void localListing;
  return {
    recorders: [],
    lookedForLocalDrive: false,
    message: "Рекордер подключён к Windows-ПК. На Mac локальный DVD-привод не ищется и не заявляется.",
  };
}

export const MOCK_IDS = {
  mac: "mac-mini",
  windows: "windows-pc",
} as const;

export const MOCK_VAULT = {
  serial: "WD-WCAV12345678",
  volumeUuid: "a1b2c3d4-1111-4aaa-8bbb-111111111111",
  filesystem: "APFS",
  volumeName: "Vault",
  totalBytes: 4_000_000_000_000,
  freeBytes: 1_200_000_000_000,
} as const;

export const MOCK_ARCHIVE = {
  serial: "ST4000DM-ARCH2019",
  volumeUuid: "b2c3d4e5-2222-4bbb-8ccc-222222222222",
  filesystem: "NTFS",
  volumeName: "Архив 2019",
  totalBytes: 4_000_000_000_000,
  freeBytes: 800_000_000_000,
} as const;

export const MOCK_GAMES = {
  serial: "TOSHIBA-GAMES-D",
  volumeUuid: "c3d4e5f6-3333-4ccc-8ddd-333333333333",
  filesystem: "NTFS",
  volumeName: "Игры",
  totalBytes: 2_000_000_000_000,
  freeBytes: 400_000_000_000,
} as const;

export const MOCK_BACKUP = {
  serial: "SEAGATE-BACKUP-9",
  volumeUuid: "d4e5f607-4444-4ddd-8eee-444444444444",
  filesystem: "exFAT",
  volumeName: "BACKUP",
  totalBytes: 1_000_000_000_000,
  freeBytes: 900_000_000_000,
} as const;

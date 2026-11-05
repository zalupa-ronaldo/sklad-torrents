import { describe, expect, it } from "vitest";

import { detectDrives, parseDiskutilInfo, parseDrutilStatus, parseWindowsDrives } from "@/lib/optical/detect";

const DRUTIL = `
 Vendor   Product           Rev
 MATSHITA DVD-R   UJ-8A8    HA13

           Type: DVD-RW               Name: /dev/disk2
      Book Type: DVD-RW (v1)
`;

const DISKUTIL = `
   Device Node:               /dev/disk2
   Device Location:           Internal
   Optical Media Type:        DVD-RW
   Volume Name:               MIX
   Volume UUID:               4E3A1C2B-1111-2222-3333-444455556666
`;

describe("optical detection", () => {
  it("returns no drive on linux without spawning", async () => {
    const calls: string[] = [];
    const result = await detectDrives({
      platform: "linux",
      demo: false,
      exec: async (argv) => {
        calls.push(argv.join(" "));
        return { code: 0, stdout: "", stderr: "", mock: false };
      },
    });
    expect(result.status).toBe("no-drive");
    expect(result.drives).toEqual([]);
    expect(result.detail).toMatch(/не найден/i);
    expect(calls).toEqual([]);
  });

  it("demo mode supplies mock drives and does not invent a serial", async () => {
    let called = false;
    const result = await detectDrives({
      platform: "linux",
      demo: true,
      exec: async () => {
        called = true;
        return { code: 0, stdout: "", stderr: "", mock: false };
      },
    });
    expect(called).toBe(false);
    expect(result.status).toBe("demo");
    expect(result.drives.length).toBeGreaterThan(0);
    expect(result.drives.every((drive) => drive.demo && drive.hardwareSerial === null)).toBe(true);
  });

  it("parses drutil, diskutil, and WMI without treating a volume id as a serial", () => {
    const drives = parseDrutilStatus(DRUTIL);
    expect(drives[0]?.device).toBe("/dev/disk2");
    expect(drives[0]?.media).toBe("dvd-rw");
    const info = parseDiskutilInfo(DISKUTIL);
    expect(info.location).toBe("internal");
    expect(info.media).toBe("dvd-rw");
    expect(info.volumeUuid).toBe("4E3A1C2B-1111-2222-3333-444455556666");
    expect(info.hardwareSerial).toBeNull();
    const windows = parseWindowsDrives(
      JSON.stringify([
        {
          deviceId: "E:",
          name: "HL-DT-ST DVD+-RW",
          drive: "E:",
          mediaLoaded: true,
          mediaType: "DVD Writer",
          caption: "HL-DT-ST DVD+-RW",
          pnpDeviceId: "USBSTOR\\CDROM&VEN_HL-DT-ST",
          recorderId: "{recorder}",
          imapiMediaType: 11,
        },
      ]),
    );
    expect(windows[0]?.location).toBe("external");
    expect(windows[0]?.media).toBe("dvd-r-dl");
    expect(windows[0]?.hardwareSerial).toBeNull();
    expect(windows[0]?.demo).toBe(false);
  });
});

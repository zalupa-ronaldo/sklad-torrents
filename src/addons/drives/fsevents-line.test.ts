import { describe, expect, it } from "vitest";

import { parseFsEventLine } from "@/addons/drives/fsevents-line";

describe("FSEvents helper lines", () => {
  it("keeps the cursor and marks a dropped history", () => {
    expect(parseFsEventLine('{"cursor":120}')).toEqual({ path: undefined, cursor: "120", lost: false });
    expect(parseFsEventLine('{"path":"/Volumes/vault/a.txt","id":121,"lost":false}')).toEqual({
      path: "/Volumes/vault/a.txt",
      cursor: "121",
      lost: false,
    });
    expect(parseFsEventLine('{"path":"/Volumes/vault","id":4,"lost":true}')?.lost).toBe(true);
    expect(parseFsEventLine("not-json")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { canGoBack, canGoForward, createFolderHistory, currentPlace, goBack, goForward, pushPlace } from "@/addons/drives/folder-history";
import { createMouseNavSession, mouseNavAction } from "@/addons/drives/mouse-nav";

describe("folder history", () => {
  it("goes back and forward one step and drops the forward branch after a new folder", () => {
    let history = createFolderHistory({ diskId: null, path: "" });
    history = pushPlace(history, { diskId: "vault", path: "" });
    history = pushPlace(history, { diskId: "vault", path: "Archives" });
    history = pushPlace(history, { diskId: "vault", path: "Archives/Games" });
    history = goBack(history);
    expect(currentPlace(history)).toEqual({ diskId: "vault", path: "Archives" });
    history = pushPlace(history, { diskId: "data", path: "Users" });
    expect(canGoForward(history)).toBe(false);
    expect(currentPlace(history).path).toBe("Users");
    const stuck = goBack(goBack(goBack(goBack(history))));
    expect(canGoBack(stuck)).toBe(false);
    expect(currentPlace(stuck)).toEqual({ diskId: null, path: "" });
    expect(goForward(stuck)).not.toBe(stuck);
  });

  it("treats one side-button click as one step and ignores left, middle, and right", () => {
    const steps: string[] = [];
    const session = createMouseNavSession((action) => steps.push(action));
    const prevented: boolean[] = [];
    const event = (button: number) => ({
      button,
      preventDefault() { prevented.push(true); },
      stopPropagation() { /* recorded via preventDefault */ },
    });
    expect(mouseNavAction(0)).toBeNull();
    expect(mouseNavAction(1)).toBeNull();
    expect(mouseNavAction(2)).toBeNull();
    session.mousedown(event(0));
    session.mouseup(event(1));
    session.auxclick(event(2));
    expect(steps).toEqual([]);
    const down = event(3);
    session.mousedown(down);
    session.mouseup(event(3));
    session.auxclick(event(3));
    expect(steps).toEqual(["back"]);
    expect(prevented.length).toBeGreaterThan(0);
    session.mousedown(event(4));
    session.mouseup(event(4));
    expect(steps).toEqual(["back", "forward"]);
  });
});

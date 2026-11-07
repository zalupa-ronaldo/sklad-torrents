export type MouseNavAction = "back" | "forward";

export interface MouseNavEvent {
  button: number;
  preventDefault(): void;
  stopPropagation(): void;
}

/** Side buttons are 3 (back) and 4 (forward). Left, middle, and right stay with the browser. */
export function mouseNavAction(button: number): MouseNavAction | null {
  if (button === 3) return "back";
  if (button === 4) return "forward";
  return null;
}

/**
 * One physical click is one step.
 * mousedown arms the click, mouseup takes it, and auxclick is ignored if mouseup already ran.
 * A browser that only emits auxclick still takes a single step.
 */
export function createMouseNavSession(onAction: (action: MouseNavAction) => void) {
  let taken = false;
  const arm = (event: MouseNavEvent): MouseNavAction | null => {
    const action = mouseNavAction(event.button);
    if (!action) return null;
    event.preventDefault();
    event.stopPropagation();
    return action;
  };
  return {
    mousedown(event: MouseNavEvent) {
      if (!arm(event)) return;
      taken = false;
    },
    mouseup(event: MouseNavEvent) {
      const action = arm(event);
      if (!action || taken) return;
      taken = true;
      onAction(action);
    },
    auxclick(event: MouseNavEvent) {
      const action = arm(event);
      if (!action || taken) return;
      taken = true;
      onAction(action);
    },
  };
}

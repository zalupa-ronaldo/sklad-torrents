/**
 * Game-mode wiring for the Windows agent.
 * The decision lives in src/lib/game-mode. This file does not spawn HandBrake,
 * compact, nsz, or qBittorrent. Mock mode does not apply suspend effects.
 */

export function createGameService(options) {
  let state = options.empty();
  let library = [];
  const processes = new Map();
  const listeners = new Set();
  const publish = () => {
    const view = options.viewOf(state);
    for (const listener of listeners) listener(view);
  };
  return {
    view() {
      return options.viewOf(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setLibrary(entries) {
      library = Array.isArray(entries) ? entries : [];
    },
    noteProcess(row) {
      if (!row || !Number.isInteger(row.pid) || row.pid <= 0) return;
      if (row.type === "stop") processes.delete(row.pid);
      else processes.set(row.pid, row);
    },
    async sync(signal = {}) {
      const next = options.reduce(state, {
        mode: signal.mode,
        processes: signal.processes || [...processes.values()],
        library: signal.library || library,
        jobs: options.jobs ? options.jobs() : [],
        downloads: signal.downloads || [],
      });
      state = next.state;
      if (options.holdJobs) options.holdJobs(state.active);
      if (!options.mock && options.apply) await options.apply(next.effects);
      publish();
      return this.view();
    },
  };
}

export function consumeWatchLine(service, line) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!row || typeof row !== "object" || row.lost === true) return null;
  service.noteProcess(row);
  return service.sync({});
}

export function watchGameProcesses({ spawn, script, onLine }) {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let buffer = "";
  child.stdout?.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  });
  return () => {
    child.kill();
  };
}

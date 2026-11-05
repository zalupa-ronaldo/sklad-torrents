import type { OpticalDrive, OpticalJob } from "../../src/lib/optical/types";

export declare class WindowsOpticalWorker {
  readonly mock: boolean;
  listDrives(): OpticalDrive[];
  submit(job: OpticalJob): Promise<OpticalJob>;
  getJob(id: string): Promise<OpticalJob | null>;
  listJobs(): Promise<OpticalJob[]>;
}

export interface StartedWindowsAgent {
  url: string;
  host: "pc-agent";
  mock: boolean;
  worker: WindowsOpticalWorker;
  close: () => Promise<void>;
}

export declare function startWindowsAgent(options?: {
  host?: string;
  port?: number;
  mock?: boolean;
  dataDir?: string | null;
  drives?: OpticalDrive[];
}): Promise<StartedWindowsAgent>;

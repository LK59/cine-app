export const KEEP_HOURS: number;
export const KEEP_BUILDS: number;
export function carryOverStatic(options: { appDir: string; dataDir: string; now?: number }): {
  buildId: string;
  carried: string[];
  removed: string[];
};

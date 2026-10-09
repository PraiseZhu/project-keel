export const MARK: string;
export const ORIGIN_MISSING: string;
export const GATE_SCRIPT: string;
export function defaultConfigPath(target: string): string;
export function defaultOwnersRoot(): string;
export function parseArgs(argv: readonly string[]): {
  cmd: string; target: string; config: string; dataDir: string; ownersRoot: string; dryRun: boolean;
};
export function discoverDataDir(ownersRoot?: string): Promise<string>;
export function keelCommand(target: string, indexPath: string, execPath?: string, script?: string): string;
export function keelGroup(target: string, indexPath: string): { hooks: { type: string; command: string; timeout: number }[] };
export function hasKeelStop(config: unknown): boolean;
export function mergeKeelStop(config: unknown, target: string, indexPath: string): any;
export function removeKeelStop(config: unknown): any;
export function isVacuousConfig(config: unknown): boolean;
export function originWasMissing(configPath: string): Promise<boolean>;
export function readConfig(configPath: string): Promise<{ existed: boolean; config: any }>;
export function installHook(opts: { target: string; config?: string; dataDir?: string; ownersRoot?: string; dryRun?: boolean }): Promise<{
  dryRun: boolean; configPath: string; existed: boolean; backup?: string; content?: string; next: any;
}>;
export function uninstallHook(opts: { target: string; config?: string; dryRun?: boolean }): Promise<{
  dryRun: boolean; configPath: string; existed: boolean; deleted: boolean; content?: string; next: any;
}>;
export function statusHook(opts: { target: string; config?: string }): Promise<{
  target: string; configPath: string; installed: boolean; note?: string;
}>;

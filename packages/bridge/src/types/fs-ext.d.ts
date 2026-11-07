declare module "fs-ext" {
  export const constants: {
    LOCK_SH: number;
    LOCK_EX: number;
    LOCK_NB: number;
    LOCK_UN: number;
  };

  export function flock(
    fd: number,
    flags: number | string,
    callback: (err?: NodeJS.ErrnoException | null) => void,
  ): void;

  export function flockSync(fd: number, flags: number | string): void;
  export function fcntl(fd: number, cmd: number, arg?: number): Promise<number>;
  export function fcntlSync(fd: number, cmd: number, arg?: number): number;
  export function seek(fd: number, offset: number, whence: number): Promise<number>;
  export function seekSync(fd: number, offset: number, whence: number): number;
  export function statVFS(path: string): Promise<unknown>;
}

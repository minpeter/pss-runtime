export type DataDirectoryResolver = () => Promise<string>;

export type FileExecutionLock = <T>(fn: () => Promise<T>) => Promise<T>;

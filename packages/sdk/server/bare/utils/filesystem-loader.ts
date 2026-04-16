import fs from "bare-fs";
import path from "bare-path";

export interface FilesystemLoader {
  ready(): Promise<void>;
  close(): Promise<void>;
  getStream(filePath: string): Promise<AsyncIterable<Buffer>>;
  list(directoryPath?: string): Promise<string[]>;
  download(
    filePath: string,
    opts: { diskPath: string; progressReporter?: unknown },
  ): Promise<{ await(): Promise<void> }>;
  getFileSize?(filePath: string): Promise<number>;
}

export function createFilesystemLoader(dirPath: string): FilesystemLoader {
  return {
    ready(): Promise<void> {
      return Promise.resolve();
    },

    close(): Promise<void> {
      return Promise.resolve();
    },

    getStream(filePath: string): Promise<AsyncIterable<Buffer>> {
      const fullPath = path.join(dirPath, filePath);
      return Promise.resolve(
        fs.createReadStream(fullPath) as unknown as AsyncIterable<Buffer>,
      );
    },

    list(directoryPath = "."): Promise<string[]> {
      const fullPath = path.join(dirPath, directoryPath);
      return Promise.resolve(fs.readdirSync(fullPath) as string[]);
    },

    download(): Promise<{ await(): Promise<void> }> {
      return Promise.reject(
        new Error("download not supported for filesystem loader"),
      );
    },
  };
}

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function isMainModule(
  moduleUrl: string,
  argvPath = process.argv[1],
): boolean {
  return (
    argvPath !== undefined &&
    moduleUrl === pathToFileURL(resolve(argvPath)).href
  );
}

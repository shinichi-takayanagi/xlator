import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot = new URL("../../", import.meta.url);

export function resolve(specifier, context, nextResolve) {
  let resolved = specifier;
  if (specifier.startsWith("@/")) resolved = new URL(specifier.slice(2), projectRoot).href;
  if (resolved.startsWith(".") || resolved.startsWith("file:")) {
    const url = new URL(resolved, context.parentURL);
    if (!/\.[a-z]+$/u.test(url.pathname)) {
      for (const extension of [".ts", ".tsx"]) {
        if (existsSync(fileURLToPath(new URL(`${url.href}${extension}`)))) {
          resolved = `${url.href}${extension}`;
          break;
        }
      }
    }
  }
  return nextResolve(resolved, context);
}

export function load(url, context, nextLoad) {
  if (/\.tsx?$/u.test(url) && !url.includes("/node_modules/")) {
    const source = readFileSync(new URL(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
        },
        fileName: fileURLToPath(url),
      }).outputText,
    };
  }
  return nextLoad(url, context);
}

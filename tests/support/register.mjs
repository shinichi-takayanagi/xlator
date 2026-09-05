import { registerHooks } from "node:module";
import { resolve, load } from "./typescript-loader.mjs";
registerHooks({ resolve, load });

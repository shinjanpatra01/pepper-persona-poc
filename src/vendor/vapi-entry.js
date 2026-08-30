// Bundle entry for the browser build of the Vapi SDK.
//
// The package ships CommonJS and does `exports.default = Vapi`. When esbuild
// bundles that as ESM its interop makes `module.exports` the default export,
// so a plain `import Vapi from "@vapi-ai/web"` yields `{ default: Vapi }` -
// an object, not a constructor. Unwrap it here, tolerating either shape so a
// future release that ships real ESM does not break this.
import * as mod from "@vapi-ai/web";

const resolved =
  typeof mod.default === "function"
    ? mod.default
    : typeof mod.default?.default === "function"
      ? mod.default.default
      : typeof mod.Vapi === "function"
        ? mod.Vapi
        : null;

if (!resolved) {
  throw new Error("Could not find the Vapi constructor in @vapi-ai/web.");
}

export default resolved;

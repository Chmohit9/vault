// src/instrumentation.ts
// Next.js server-startup hook (stable since Next 15). Starts the autopilot loop automatically when
// VAULT_AUTOPILOT=on, so the demo can boot straight into self-healing mode without a manual API call.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initAutopilotFromEnv } = await import("./lib/autopilot/loop");
    initAutopilotFromEnv();
  }
}
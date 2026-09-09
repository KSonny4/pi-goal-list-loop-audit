// Fresh process fixture: real extension handlers, fake host API only.
import * as fs from "node:fs";
import * as path from "node:path";
import activate from "../../extensions/loops/goal.js";
import { readState } from "../../extensions/goal-loop-core.js";
import { MockPi, makeMockCtx } from "../harness/mock-pi.js";

const [cwd, mode] = process.argv.slice(2) as [string, string];
const pi = new MockPi();
activate(pi.api);
const ctx = makeMockCtx(cwd);
const models = ["approved", "fallback", "session"].map((id) => ({ provider: "test", id }));
(ctx as any).model = models[2];
(ctx as any).modelRegistry = {
  find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
  getAvailable: () => models,
  hasConfiguredAuth: () => true,
};
await pi.fire("session_start", { reason: "startup" }, ctx);
if (mode === "start" || mode === "before") {
  await pi.command("goal", "Create the audited artifact — done when artifact exists", ctx);
  if (mode === "before") {
    fs.writeFileSync(path.join(cwd, "before-ready"), "ready");
  } else {
    await pi.runTool("complete_goal", { completionSummary: "Implemented audited artifact", verificationSummary: "Deterministic fixture validates the artifact" }, ctx);
  }
  setInterval(() => {}, 1000);
} else {
  await pi.command("goal", "verify", ctx);
  const deadline = Date.now() + 10000;
  while (readState(cwd).goal?.status === "auditing") {
    if (Date.now() > deadline) throw new Error("resume settlement deadline");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  fs.writeFileSync(path.join(cwd, "resume-receipt.json"), JSON.stringify({ state: readState(cwd), notices: ctx.ui.notifies }));
  await pi.fire("session_shutdown", { reason: "quit" }, ctx);
  process.exit(0);
}

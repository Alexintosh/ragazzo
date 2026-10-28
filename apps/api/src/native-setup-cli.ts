import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { approveNativeSetup } from "@rakazo/adapters";

const args = process.argv.slice(2);
function option(name: string, fallback?: string) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("Missing option");
  return value;
}
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Local terminal required");
  const session = option("--session");
  if (!session) throw new Error("Setup session required");
  const root = path.resolve(option("--data-dir", path.join(homedir(), ".rakazo", "host"))!);
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const approved = await approveNativeSetup(root, session, async (plan) => {
      process.stdout.write(
        `${plan.warning}\nDestination: ${plan.destination}\nCommand: ${plan.command.map((part) => JSON.stringify(part)).join(" ")}\n`,
      );
      return (await input.question("Allow this action on this host? Type yes: ")).trim() === "yes";
    });
    process.stdout.write(
      approved
        ? "Approved. Keep the host bridge running and check setup in the app.\n"
        : "Cancelled.\n",
    );
  } finally {
    input.close();
  }
}
void main().catch(() => {
  process.stderr.write("Setup approval failed. Check the data directory, session and expiry.\n");
  process.exitCode = 1;
});

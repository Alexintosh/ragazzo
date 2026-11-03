const origin = process.argv[2];
if (!origin || !/^https:\/\/[a-z0-9.-]+$/.test(origin))
  throw new Error("Pass the public https://hostname");
let passed = false;
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    const [build, session] = await Promise.all([
      fetch(`${origin}/build-id`, {
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
        cache: "no-store",
      }),
      fetch(`${origin}/api/auth/get-session`, {
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
        cache: "no-store",
      }),
    ]);
    if (
      !build.ok ||
      !session.ok ||
      !session.headers.get("content-type")?.includes("application/json")
    )
      throw new Error("HTTP health check failed");
    const id = (await build.text()).trim();
    if (!id || id.length > 200 || id.includes("<")) throw new Error("Invalid build response");
    await session.json();
    passed = true;
    break;
  } catch {
    if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
if (!passed)
  throw new Error("Public web/API checks did not pass; inspect Tunnel and origin health");
console.log("Public web and anonymous API checks passed.");

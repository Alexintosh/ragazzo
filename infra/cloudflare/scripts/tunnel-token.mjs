// biome-ignore lint/suspicious/noUndeclaredEnvVars: operator-only CLI, never a cached Turbo task.
export async function tunnelToken(deployment, token = process.env.CLOUDFLARE_API_TOKEN) {
  if (!token) throw new Error("Set CLOUDFLARE_API_TOKEN to retrieve the connector token");
  if (
    !/^[a-f0-9]{32}$/.test(deployment.account_id) ||
    !/^[a-f0-9-]{36}$/.test(deployment.tunnel_id)
  )
    throw new Error("Invalid account or tunnel ID");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${deployment.account_id}/cfd_tunnel/${deployment.tunnel_id}/token`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    },
  );
  if (!response.ok) throw new Error(`Could not retrieve tunnel token (HTTP ${response.status})`);
  const data = await response.json();
  if (!data.success || typeof data.result !== "string" || !/^[A-Za-z0-9+/=_-]+$/.test(data.result))
    throw new Error("Cloudflare did not return a valid connector token");
  return data.result;
}

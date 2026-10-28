import { useEffect, useState } from "react";
import { rpc } from "./api";

/** Only offer Docker once this deployment confirms it can run it. */
export function useSandboxProvider() {
  const [environment, setEnvironment] = useState<{
    provider?: string | null;
    failed?: boolean;
  }>();
  useEffect(() => {
    let active = true;
    void rpc("me").then(
      (me) => {
        if (active) setEnvironment({ provider: me.sandboxProvider });
      },
      () => {
        if (active) setEnvironment({ failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return {
    dockerAvailable: environment?.provider === "docker",
    loading: !environment,
    failed: environment?.failed ?? false,
  };
}

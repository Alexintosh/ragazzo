import { useEffect, useState } from "react";
import { rpc } from "./api";

/** Only offer local execution choices confirmed by this deployment. */
export function useSandboxProvider() {
  const [environment, setEnvironment] = useState<{
    provider?: string | null;
    localHostConfigured?: boolean;
    failed?: boolean;
  }>();
  useEffect(() => {
    let active = true;
    void rpc("me").then(
      (me) => {
        if (active)
          setEnvironment({
            provider: me.sandboxProvider,
            localHostConfigured: me.localHostConfigured === true,
          });
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
    localHostConfigured: environment?.localHostConfigured === true,
    loading: !environment,
    failed: environment?.failed ?? false,
  };
}

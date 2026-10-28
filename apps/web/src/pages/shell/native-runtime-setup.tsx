import { useLingui } from "@lingui/react/macro";
import type { NativeSetupInput, NativeSetupKind, NativeSetupView } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { useSpaceRpc } from "../../lib/space-rpc";

export function NativeRuntimeSetup(props: { kind: NativeSetupKind; hostId: string | null }) {
  return <SetupPanel key={`${props.kind}:${props.hostId}`} {...props} />;
}
function SetupPanel({ kind, hostId }: { kind: NativeSetupKind; hostId: string | null }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<NativeSetupView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const owner = useRef(rpc),
    sequence = useRef(0),
    changing = useRef(false),
    mounted = useRef(true);
  owner.current = rpc;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    changing.current = false;
    setBusy(false);
    setView(undefined);
  }, [rpc]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    let fetching = false;
    const refresh = async () => {
      if (fetching || changing.current) return;
      fetching = true;
      const request = ++sequence.current;
      try {
        const next = await rpc.nativeSetup.request({ kind, hostId, action: "status" });
        if (current && owner.current === rpc && sequence.current === request) {
          setView(next);
          setError(false);
        }
      } catch {
        if (current && owner.current === rpc && sequence.current === request) {
          setView(undefined);
          setError(true);
        }
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      current = false;
      clearInterval(timer);
      setView(undefined);
    };
  }, [open, rpc, kind, hostId]);
  async function act(action: NativeSetupInput["action"]) {
    const request = ++sequence.current;
    changing.current = true;
    setBusy(true);
    setError(false);
    const sessionId = view?.session?.id;
    if (action === "cancel") setView(undefined);
    try {
      const next = await rpc.nativeSetup.request({
        kind,
        hostId,
        action,
        ...(action === "cancel" ? { sessionId } : {}),
      });
      if (mounted.current && owner.current === rpc && sequence.current === request) setView(next);
    } catch {
      if (mounted.current && owner.current === rpc) setError(true);
    } finally {
      if (mounted.current && owner.current === rpc) {
        changing.current = false;
        setBusy(false);
      }
    }
  }
  const session = view?.session;
  const active = session && ["awaiting-consent", "running"].includes(session.state);
  const states = {
    "awaiting-consent": t`Approve in the host terminal`,
    running: t`Setup running`,
    succeeded: t`Setup complete`,
    failed: t`Setup failed`,
    cancelled: t`Setup cancelled`,
    expired: t`Setup expired`,
  };
  return (
    <div className="space-y-2 text-xs">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(!open)}
      >{t`Set up runtime`}</Button>
      {open ? (
        <div className="space-y-2">
          {error ? <p role="alert">{t`Could not check runtime setup`}</p> : null}
          {view ? (
            <>
              <p role="status">
                {view.authenticated
                  ? t`Runtime ready`
                  : view.available
                    ? t`Sign-in required`
                    : t`CLI unavailable`}
              </p>
              {kind === "acp" ? (
                <p>{t`Configure the ACP command in the host’s private native-providers.json file.`}</p>
              ) : null}
              {!active ? (
                <div className="flex gap-2">
                  {!view.available && view.installSupported ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void act("install")}
                    >{t`Prepare install`}</Button>
                  ) : null}
                  {view.available && view.loginSupported ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void act("login")}
                    >{t`Prepare sign-in`}</Button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          {session ? (
            <>
              <p role="status">{states[session.state]}</p>
              {session.state === "awaiting-consent" ? (
                <>
                  <p>{session.destination}</p>
                  <pre className="whitespace-pre-wrap break-all rounded bg-muted p-2">
                    {session.command.map((part) => JSON.stringify(part)).join(" ")}
                  </pre>
                  <pre className="whitespace-pre-wrap break-all rounded bg-muted p-2">
                    {session.localApproval}
                  </pre>
                </>
              ) : null}
              {session.verificationUrl ? (
                <a
                  className="underline"
                  href={session.verificationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >{t`Continue sign-in`}</a>
              ) : null}
              {session.userCode ? (
                <p>
                  {t`Device code`}: <code>{session.userCode}</code>
                </p>
              ) : null}
              {session.action === "login" && kind === "claude" && session.state === "running" ? (
                <p>{t`Continue in the host browser.`}</p>
              ) : null}
              {active ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act("cancel")}
                >{t`Cancel setup`}</Button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

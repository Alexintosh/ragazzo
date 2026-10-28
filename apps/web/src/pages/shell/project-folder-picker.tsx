import { Trans, useLingui } from "@lingui/react/macro";
import type { HostDirectoriesView } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
import { ChevronRight, Folder } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSpaceRpc } from "../../lib/space-rpc";

export function ProjectFolderPicker({
  id,
  hostId,
  value,
  onChange,
}: {
  id: string;
  hostId: string | null;
  value: string | null;
  onChange: (path: string | null) => void;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const generation = useRef(0);
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<HostDirectoriesView>();
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    generation.current++;
    setOpen(false);
    setListing(undefined);
    setDestination("");
    setBusy(false);
    setError("");
    return () => {
      generation.current++;
    };
  }, [hostId, rpc]);
  function close() {
    generation.current++;
    setOpen(false);
    setListing(undefined);
  }
  async function navigate(path?: string) {
    const started = ++generation.current;
    setBusy(true);
    setError("");
    setListing(undefined);
    try {
      const next = await rpc.hosts.directories({ hostId, ...(path ? { path } : {}) });
      if (generation.current !== started) return;
      setListing(next);
      setDestination(next.path);
    } catch {
      if (generation.current === started)
        setError(t`Could not open folder. Check the path and host access.`);
    } finally {
      if (generation.current === started) setBusy(false);
    }
  }
  return (
    <div className="space-y-2 text-sm">
      <label htmlFor={id}>
        <Trans>Project folder</Trans>
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value ?? ""}
          placeholder={t`Absolute path on host`}
          onChange={(event) => onChange(event.target.value || null)}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setOpen(true);
            setDestination(value ?? "");
            void navigate(value || undefined);
          }}
        >{t`Browse`}</Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Project folder</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>Browse folders in the host home directory.</Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input
              aria-label={t`Folder path`}
              disabled={busy}
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void navigate(destination || undefined);
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void navigate(destination || undefined)}
            >{t`Open`}</Button>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void navigate()}
            >{t`Home`}</Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy || !listing?.parent}
              onClick={() => void navigate(listing?.parent ?? undefined)}
            >{t`Up`}</Button>
          </div>
          <div className="max-h-64 min-h-32 overflow-y-auto" aria-busy={busy}>
            {busy ? (
              <p role="status" className="p-2 text-muted-foreground">{t`Loading folders…`}</p>
            ) : null}
            {listing?.directories.map((directory) => (
              <Button
                key={directory.path}
                type="button"
                variant="ghost"
                className="w-full justify-start"
                onClick={() => void navigate(directory.path)}
              >
                <Folder aria-hidden="true" className="size-4 shrink-0" />
                <span className="truncate">{directory.name}</span>
                <ChevronRight aria-hidden="true" className="ml-auto size-4 shrink-0" />
              </Button>
            ))}
            {listing && !listing.directories.length ? (
              <p className="p-2 text-muted-foreground">{t`No folders`}</p>
            ) : null}
            {listing?.truncated ? (
              <p className="p-2 text-muted-foreground">{t`Enter a path to find other folders.`}</p>
            ) : null}
            {error ? (
              <p role="alert" className="p-2 text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>{t`Cancel`}</Button>
            <Button
              type="button"
              disabled={!listing || busy || destination !== listing.path}
              onClick={() => {
                if (!listing) return;
                onChange(listing.path);
                close();
              }}
            >{t`Use folder`}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

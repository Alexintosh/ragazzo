import { Trans, useLingui } from "@lingui/react/macro";
import type { ConversationFile } from "@rakazo/contracts";
import { Button, Input, Spinner } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Download, File, MessageSquare } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { decodeArtifactBase64, downloadArtifactBytes } from "../../lib/artifact-open";
import type { RpcClient } from "../../lib/rpc";

export type ConversationFilesTarget = { botId: string } | { groupId: string } | { taskId: string };

/** Uses the shell's space-bound client; late replies cannot change the active tenant. */
export function ConversationFilesPanel({
  rpc,
  target,
  onJumpToMessage,
  spaceId,
}: {
  rpc: RpcClient;
  spaceId: string | null;
  target: ConversationFilesTarget;
  onJumpToMessage: (messageId: string) => void;
}) {
  const { t } = useLingui();
  const [search, setSearch] = useState("");
  const [downloadError, setDownloadError] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const files = useQuery({
    queryKey: ["conversation-files", spaceId, target],
    queryFn: () => rpc.artifacts.listConversation(target),
    staleTime: 0,
  });
  async function download(file: ConversationFile) {
    setDownloadError(false);
    setDownloading(file.id);
    try {
      const content = await rpc.artifacts.getById({ artifactId: file.id });
      downloadArtifactBytes(file.name, file.mimeType, decodeArtifactBase64(content.contentBase64));
    } catch {
      setDownloadError(true);
    } finally {
      setDownloading(null);
    }
  }
  return (
    <section
      aria-label={t`Conversation files`}
      data-testid="conversation-files-panel"
      className="space-y-4"
    >
      {files.isPending ? (
        <Spinner aria-label={t`Loading files…`} />
      ) : files.isError ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>
            <Trans>Could not load files.</Trans>
          </p>
          <Button variant="outline" size="sm" onClick={() => void files.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="conversation-files-storage">
            <Trans>
              {files.data.storage.files} files · {formatFileBytes(files.data.storage.bytes)} stored,
              including versions
            </Trans>
          </p>
          {files.data.items.length ? (
            <Input
              aria-label={t`Search files`}
              placeholder={t`Search files`}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          ) : null}
          <ul className="divide-y divide-border">
            {files.data.items
              .filter((file) => file.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
              .map((file) => (
                <li key={file.familyId} className="space-y-2 py-3" data-testid="conversation-file">
                  <div className="flex min-w-0 items-start gap-2">
                    <File
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                    <Link
                      to={`/app/artifacts/${encodeURIComponent(file.familyId)}`}
                      className="min-w-0 break-all text-sm hover:underline"
                    >
                      {file.name}
                    </Link>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {file.origin === "attachment"
                      ? t`Attachment`
                      : file.origin === "generated"
                        ? t`Generated`
                        : t`File`}
                    {" · "}
                    {formatFileBytes(file.size)}
                    {file.versionCount > 1 ? (
                      <>
                        {" "}
                        · <Trans>{file.versionCount} versions</Trans>
                      </>
                    ) : null}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t`Download ${file.name}`}
                      disabled={downloading !== null}
                      onClick={() => void download(file)}
                    >
                      <Download aria-hidden="true" className="size-3.5" />
                      <Trans>Download</Trans>
                    </Button>
                    {file.messageId ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t`Show message for ${file.name}`}
                        onClick={() => onJumpToMessage(file.messageId!)}
                      >
                        <MessageSquare aria-hidden="true" className="size-3.5" />
                        <Trans>Show message</Trans>
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
          </ul>
          {!files.data.items.length ? (
            <p className="text-sm text-muted-foreground">
              <Trans>No files yet.</Trans>
            </p>
          ) : !files.data.items.some((file) =>
              file.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
            ) ? (
            <p className="text-sm text-muted-foreground">
              <Trans>No files found.</Trans>
            </p>
          ) : null}
        </>
      )}
      {downloadError ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not download file.</Trans>
        </p>
      ) : null}
    </section>
  );
}

export function formatFileBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

import { useLingui } from "@lingui/react/macro";
import type { RoleplayCharacter } from "@rakazo/contracts";
import { Button, Input, Switch, Textarea } from "@rakazo/ui-web";
import { useId, useRef, useState } from "react";
import { readFileAsBase64 } from "../../lib/pending-attachments";
import { prepareImage } from "../../lib/prepare-image";
import { rpc } from "../../lib/rpc";
import { useArtifactImage } from "../../lib/use-artifact-image";
import { errorText } from "../../lib/user-error";

type Media = NonNullable<RoleplayCharacter["media"]>;
export function RoleplayImages({
  botId,
  value,
  onChange,
  errors = {},
  onPendingChange,
}: {
  onPendingChange?: (pending: boolean) => void;
  errors?: Record<string, string>;
  botId: string;
  value: RoleplayCharacter["media"];
  onChange: (value: Media) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const media: Media = value ?? {
    enabled: false,
    allowSpontaneous: false,
    normalIntervalTurns: 6,
    storyIntervalTurns: 2,
    album: [],
  };
  const current = useRef(media);
  current.current = media;
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const uploading = useRef(false);
  function update(patch: Partial<Media>) {
    onChange({ ...current.current, ...patch });
  }
  async function add(file?: File) {
    if (uploading.current || current.current.album.length >= 32) return;
    uploading.current = true;
    onPendingChange?.(true);
    setPending(true);
    setFailure(null);
    try {
      const prepared = file ? await prepareImage(file) : null;
      const artifact = prepared
        ? await rpc.artifacts.create({
            botId,
            name: prepared.name,
            mimeType: prepared.type,
            contentBase64: await readFileAsBase64(prepared),
          })
        : await rpc.bots.importRoleplayMedia({ botId, url });
      if (current.current.album.some((entry) => entry.artifactId === artifact.id)) return;
      update({
        album: [
          ...current.current.album,
          {
            id: crypto.randomUUID(),
            artifactId: artifact.id,
            description: artifact.name,
            enabled: true,
          },
        ],
      });
      setUrl("");
    } catch (error) {
      setFailure(errorText(error, t`Could not add image`));
    } finally {
      uploading.current = false;
      onPendingChange?.(false);
      setPending(false);
    }
  }
  return (
    <div className="space-y-4" aria-busy={pending}>
      <label htmlFor={`${id}-enabled`} className="flex items-center justify-between text-sm">
        {t`Images`}
        <Switch
          id={`${id}-enabled`}
          checked={media.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </label>
      {media.enabled ? (
        <>
          {media.album.map((entry, index) => (
            <details key={entry.id} className="rounded-lg border border-border p-3">
              <summary className="flex min-w-0 cursor-pointer items-center gap-3">
                <AlbumImage
                  botId={botId}
                  artifactId={entry.artifactId}
                  description={entry.description}
                />
                <span className="min-w-0 flex-1 truncate">{entry.description || t`Image`}</span>
              </summary>
              <div className="space-y-3 pt-3">
                <label
                  className="block text-sm"
                  htmlFor={`${id}-${entry.id}-description`}
                >{t`Description`}</label>
                <Textarea
                  id={`${id}-${entry.id}-description`}
                  maxLength={800}
                  aria-invalid={Boolean(errors[`media.album.${index}.description`])}
                  value={entry.description}
                  onChange={(event) =>
                    update({
                      album: media.album.map((image, i) =>
                        i === index ? { ...image, description: event.target.value } : image,
                      ),
                    })
                  }
                />
                <label
                  className="block text-sm"
                  htmlFor={`${id}-${entry.id}-scene`}
                >{t`Scene`}</label>
                <Input
                  id={`${id}-${entry.id}-scene`}
                  maxLength={400}
                  aria-invalid={Boolean(errors[`media.album.${index}.scene`])}
                  value={entry.scene ?? ""}
                  onChange={(event) =>
                    update({
                      album: media.album.map((image, i) =>
                        i === index ? { ...image, scene: event.target.value || undefined } : image,
                      ),
                    })
                  }
                />
                <label
                  htmlFor={`${id}-${entry.id}-enabled`}
                  className="flex items-center justify-between text-sm"
                >
                  {t`Enabled`}
                  <Switch
                    id={`${id}-${entry.id}-enabled`}
                    checked={entry.enabled}
                    onCheckedChange={(enabled) =>
                      update({
                        album: media.album.map((image, i) =>
                          i === index ? { ...image, enabled } : image,
                        ),
                      })
                    }
                  />
                </label>
                <Button
                  variant="ghost"
                  onClick={() =>
                    update({ album: media.album.filter((image) => image.id !== entry.id) })
                  }
                >{t`Remove image`}</Button>
              </div>
            </details>
          ))}
          <fieldset disabled={pending || media.album.length >= 32} className="min-w-0 space-y-3">
            <label htmlFor={`${id}-upload`} className="block text-sm">{t`Upload image`}</label>
            <Input
              id={`${id}-upload`}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="min-w-0 max-w-full"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void add(file);
                event.target.value = "";
              }}
            />
            <details>
              <summary className="cursor-pointer text-sm">{t`Import from URL`}</summary>
              <div className="flex min-w-0 gap-2 pt-3">
                <Input
                  aria-label={t`Image URL`}
                  type="url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
                <Button
                  disabled={!url.trim() || pending}
                  onClick={() => void add()}
                >{t`Import`}</Button>
              </div>
            </details>
          </fieldset>
          <details>
            <summary className="cursor-pointer text-sm">{t`Frequency`}</summary>
            <div className="space-y-3 pt-3">
              <label
                htmlFor={`${id}-spontaneous`}
                className="flex items-center justify-between text-sm"
              >
                {t`Spontaneous images`}
                <Switch
                  id={`${id}-spontaneous`}
                  checked={media.allowSpontaneous}
                  onCheckedChange={(allowSpontaneous) => update({ allowSpontaneous })}
                />
              </label>
              {(
                [
                  ["normalIntervalTurns", t`Normal chat: turns between images`],
                  ["storyIntervalTurns", t`Story mode: turns between images`],
                ] as const
              ).map(([key, label]) => (
                <label key={key} htmlFor={`${id}-${key}`} className="block space-y-2 text-sm">
                  {label}
                  <Input
                    id={`${id}-${key}`}
                    type="number"
                    aria-invalid={Boolean(errors[`media.${key}`])}
                    min={1}
                    max={100}
                    value={Number.isNaN(media[key]) ? "" : media[key]}
                    onChange={(event) =>
                      update({
                        [key]: event.target.value === "" ? Number.NaN : Number(event.target.value),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </details>
        </>
      ) : null}
      {Object.entries(errors)
        .filter(([path]) => path.startsWith("media"))
        .map(([path, message]) => (
          <p key={path} role="alert" className="text-sm text-destructive">
            {message}
          </p>
        ))}
      {pending ? (
        <p role="status" className="text-sm text-muted-foreground">{t`Adding image…`}</p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
function AlbumImage({
  botId,
  artifactId,
  description,
}: {
  botId: string;
  artifactId: string;
  description: string;
}) {
  const src = useArtifactImage({ botId }, artifactId);
  return src ? (
    <img src={src} alt={description} className="size-14 shrink-0 rounded object-cover" />
  ) : (
    <span className="size-14 shrink-0 rounded bg-muted" />
  );
}

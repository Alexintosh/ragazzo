import type { Bot, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { nextAutoSpeakAction, speechFromBlocks } from "@rakazo/core";
import { toast } from "@rakazo/ui-web";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { speaker } from "../../lib/tts";

const READ_ALOUD_TOAST = "read-aloud-error";

/** Chat read-aloud has no caption to carry a failure, so it surfaces as a toast. */
function readAloud(text: string, opts: { botId: string; messageId: string }) {
  void speaker.speak(text, opts).then((error) => {
    if (error) toast.error(error, { id: READ_ALOUD_TOAST });
  });
}

/** Reads bot replies aloud: on request, and automatically for bots that speak their replies. */
export function useReadAloud({
  active,
  snapshot,
  callBotId,
  activeBotId,
}: {
  active: Bot | undefined;
  snapshot: ThreadSnapshot | null;
  callBotId: string | undefined;
  activeBotId: RefObject<string | undefined>;
}) {
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const autoSpoken = useRef<string | null>(null);
  const autoSpokenBotId = useRef<string | null>(null);

  useEffect(() => {
    const unsubSpeech = speaker.subscribe((state) => {
      setSpeakingMessageId(state.status === "idle" ? null : (state.messageId ?? null));
    });
    return () => {
      unsubSpeech();
    };
  }, []);

  useEffect(() => {
    if (!active || !snapshot || snapshot.botId !== active.id) return;
    const decision = nextAutoSpeakAction({
      botId: active.id,
      autoSpeak: active.autoSpeak && callBotId !== active.id,
      focused: true,
      snapshotReady: true,
      lastSpokenBotId: autoSpokenBotId.current,
      lastSpokenMessageId: autoSpoken.current,
      runId: snapshot.run?.id,
      runStatus: snapshot.run?.status,
      combineRunReplies:
        active.botKind === "roleplay" && active.roleplayCharacter?.conversationStyle === "chat",
      messages: snapshot.messages,
    });
    if (decision.action === "wait") return;
    autoSpokenBotId.current = active.id;
    autoSpoken.current = decision.messageId;
    if (decision.action === "seed") return;
    readAloud(decision.text, { botId: active.id, messageId: decision.messageId });
  }, [
    snapshot?.messages,
    snapshot?.run?.status,
    snapshot?.run?.id,
    snapshot?.botId,
    active?.autoSpeak,
    active?.botKind,
    active?.roleplayCharacter?.conversationStyle,
    active?.id,
    callBotId,
  ]);

  const speakingMessageIdRef = useRef(speakingMessageId);
  speakingMessageIdRef.current = speakingMessageId;
  const speakMessage = useCallback((message: ThreadMessage) => {
    if (speakingMessageIdRef.current === message.id) {
      speaker.stop();
      return;
    }
    const text = speechFromBlocks(message.blocks);
    const id = message.botId ?? activeBotId.current;
    if (text && id) readAloud(text, { botId: id, messageId: message.id });
  }, []);

  return { speakingMessageId, speakMessage };
}

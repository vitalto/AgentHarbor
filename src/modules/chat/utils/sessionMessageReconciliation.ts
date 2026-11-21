import type { ChatAttachment, ChatImage, NormalizedMessage } from '@/shared/types';

const LOCAL_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const LOCAL_USER_DEDUPE_CLOCK_SKEW_MS = 10_000;
const LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS = 30_000;

type UserTurnFingerprint = {
  text: string;
  images: ChatImage[];
  files: ChatAttachment[];
};

/**
 * The Claude TUI does not record a prompt verbatim: it drops invisible format
 * characters (the LRM/FSI/PDI Telegram puts around quoted names) and expands
 * tabs, so the echo is compared on visible characters only.
 */
function visibleCharacters(text: string): string {
  return text.replace(/[\p{Cf}\s]+/gu, '');
}

function userTurnFingerprint(message: NormalizedMessage, preserveWordBoundaries: boolean): UserTurnFingerprint | null {
  if (message.kind !== 'text' || message.role !== 'user') return null;

  const content = message.content || '';
  const text = preserveWordBoundaries
    ? content.replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim()
    : visibleCharacters(content);
  const images = Array.isArray(message.images) ? message.images : [];
  const files = Array.isArray(message.files) ? message.files : [];
  if (!text && images.length === 0 && files.length === 0) return null;

  return { text, images, files };
}

function storedAttachmentName(attachment: ChatImage): string | undefined {
  return attachment?.path?.split(/[\\/]/).pop();
}

function attachmentSourcesMatch(local: ChatImage[], persisted: ChatImage[]): boolean {
  if (local.length !== persisted.length) return false;
  if (local.length === 0) return true;
  // Staging changes an upload's directory but keeps its unique stored filename.
  // An inline image can only be compared by its bytes when both sides carry them.
  const sources = [storedAttachmentName, (attachment: ChatImage) => attachment?.data];
  return sources.every((readSource) => {
    const available = local.map(readSource);
    for (const attachment of persisted) {
      const key = readSource(attachment);
      if (!key) continue;
      const exactIndex = available.indexOf(key);
      const index = exactIndex < 0 ? available.indexOf(undefined) : exactIndex;
      if (index < 0) return false;
      available.splice(index, 1);
    }
    return true;
  });
}

function userTurnFingerprintsMatch(
  local: UserTurnFingerprint,
  server: UserTurnFingerprint,
  allowUploadedAttachmentMatch: boolean,
): boolean {
  // A unique upload name can identify the turn even if the terminal rewrote its text.
  const hasMatchingUpload = (localAttachments: ChatImage[], serverAttachments: ChatImage[]) =>
    localAttachments.some((attachment) => {
      const name = storedAttachmentName(attachment);
      return !!name && serverAttachments.some((echo) => storedAttachmentName(echo) === name);
    });
  return (
    (local.text === server.text || (allowUploadedAttachmentMatch
      && (hasMatchingUpload(local.images, server.images) || hasMatchingUpload(local.files, server.files))))
    && attachmentSourcesMatch(local.images, server.images)
    && attachmentSourcesMatch(local.files, server.files)
  );
}

function readMessageTime(message: NormalizedMessage): number | null {
  const time = Date.parse(message.timestamp);
  return Number.isFinite(time) ? time : null;
}

function findServerEchoForLocalUser(
  localMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  claimedServerIds: Set<string>,
): NormalizedMessage | null {
  const inputSubmitted = localMessage.inputSubmitted === true;
  const localFingerprint = userTurnFingerprint(localMessage, inputSubmitted);
  const localTime = readMessageTime(localMessage);
  if (!localFingerprint || localTime === null) {
    return null;
  }

  // The echo of an edited message may only be retired by a row that was not
  // in the transcript when the cut was made. Text and a time window are not
  // enough for it: a rewind that branches re-stamps every surviving turn to
  // the moment of the copy, so an earlier turn with the same words — "yes",
  // "continue", the typo being corrected — lands inside the window and would
  // retire the message the user just sent.
  const firstEligibleIndex = localMessage.replacesAfterRowCount ?? 0;

  const dedupeWindow = localFingerprint.text
    ? LOCAL_USER_DEDUPE_WINDOW_MS
    : LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS;
  let bestMatch: NormalizedMessage | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let index = firstEligibleIndex; index < serverMessages.length; index++) {
    const serverMessage = serverMessages[index];
    if (claimedServerIds.has(serverMessage.id) || localMessage.ineligibleEchoIds?.includes(serverMessage.id)) {
      continue;
    }

    const serverFingerprint = userTurnFingerprint(serverMessage, inputSubmitted);
    if (!serverFingerprint || !userTurnFingerprintsMatch(localFingerprint, serverFingerprint, inputSubmitted)) {
      continue;
    }

    const serverTime = readMessageTime(serverMessage);
    if (
      serverTime === null
      || serverTime < localTime - LOCAL_USER_DEDUPE_CLOCK_SKEW_MS
      || serverTime - localTime > dedupeWindow
    ) {
      continue;
    }

    // Consume identical submitted turns in transcript order even when the clocks disagree.
    const score = inputSubmitted ? serverTime : Math.abs(serverTime - localTime);
    if (score < bestScore) {
      bestMatch = serverMessage;
      bestScore = score;
    }
  }

  return bestMatch;
}

/** A turn already visible before the send cannot be its echo, even if the user repeats it. */
export function recordPriorUserTurns(localMessage: NormalizedMessage, visibleMessages: NormalizedMessage[]): NormalizedMessage {
  const identifiedSend = localMessage.id.startsWith('local_send_');
  if (!identifiedSend && !localMessage.images?.length && !localMessage.files?.length) return localMessage;
  const localTime = readMessageTime(localMessage);
  if (localTime === null) return localMessage;

  const priorIds = visibleMessages.filter((message) => (
    message.kind === 'text' && message.role === 'user' && !message.id.startsWith('local_')
    && (identifiedSend || message.images?.length || message.files?.length)
    && (readMessageTime(message) ?? -Infinity) >= localTime - LOCAL_USER_DEDUPE_CLOCK_SKEW_MS
  )).map((message) => message.id);
  return priorIds.length ? { ...localMessage, ineligibleEchoIds: priorIds } : localMessage;
}

export function reconcileSubmittedUserEchoes(
  transcript: NormalizedMessage[],
  realtime: NormalizedMessage[],
): NormalizedMessage[] {
  const claimedIds = new Set<string>();
  const remaining = realtime.filter((message) => {
    if (!message.inputSubmitted) return true;
    const echo = findServerEchoForLocalUser(message, transcript, claimedIds);
    if (!echo) return true;
    claimedIds.add(echo.id);
    return false;
  });
  if (claimedIds.size === 0) return realtime;

  return remaining.map((message) => message.id.startsWith('local_send_')
    ? { ...message, ineligibleEchoIds: [...(message.ineligibleEchoIds ?? []), ...claimedIds] }
    : message);
}

/**
 * Removes local optimistic user rows once a corresponding persisted turn is
 * available. Matches are one-to-one so repeated sends cannot claim one row.
 */
export function removeOptimisticUserEchoes(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  const claimedServerIds = new Set<string>();

  return realtimeMessages.filter((message) => {
    // A uniquely acknowledged web send reconciles only after terminal submission.
    if (!message.id.startsWith('local_') || message.id.startsWith('local_send_')) {
      return true;
    }

    const serverEcho = findServerEchoForLocalUser(message, serverMessages, claimedServerIds);
    if (!serverEcho) {
      return true;
    }

    claimedServerIds.add(serverEcho.id);
    return false;
  });
}

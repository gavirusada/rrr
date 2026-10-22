import { CANON_EOS_OPERATION } from "./canonEos";
import {
  parseCanonEosPropertyEvents,
  type CanonEosPropertyEvent
} from "./canonPropertyEvents";

const OK = 0x2001;

export interface CanonPropertyEventCommands {
  executeCameraCommand(request: {
    operationCode: number;
    parameters?: number[];
    acceptedResponseCodes: number[];
  }): Promise<{ responseCode: number; bytes: Uint8Array }>;
}

export interface CollectCanonPropertyEventsOptions {
  durationMs: number;
  pollDelayMs?: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

export async function collectCanonPropertyEvents(
  commands: CanonPropertyEventCommands,
  options: CollectCanonPropertyEventsOptions
): Promise<CanonEosPropertyEvent[]> {
  const pollDelayMs = options.pollDelayMs ?? 200;
  const now = options.now ?? (() => Date.now());
  const delay = options.delay ?? wait;
  const deadline = now() + options.durationMs;
  const events: CanonEosPropertyEvent[] = [];

  while (now() < deadline) {
    const response = await commands.executeCameraCommand({
      operationCode: CANON_EOS_OPERATION.GET_EVENT,
      parameters: [],
      acceptedResponseCodes: [OK]
    });

    if (response.responseCode !== OK) {
      throw new Error(
        `Canon property event polling failed with response 0x${response.responseCode.toString(16)}`
      );
    }

    events.push(...parseCanonEosPropertyEvents(response.bytes));

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      break;
    }
    await delay(Math.min(pollDelayMs, remainingMs));
  }

  return events;
}

async function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

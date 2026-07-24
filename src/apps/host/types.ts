import type { HirayaErrorCode } from "@hiraya/apps-contracts";

export type AppInstanceOwner = Readonly<{
  appId: string;
  instanceId: string;
}>;

export class HostServiceError extends Error {
  constructor(message: string, public readonly code: HirayaErrorCode) {
    super(message);
    this.name = "HostServiceError";
  }
}

export function instanceKey(owner: AppInstanceOwner): string {
  return `${owner.appId}\0${owner.instanceId}`;
}

export function unavailable(owner: AppInstanceOwner): HostServiceError {
  return new HostServiceError(`App instance ${owner.instanceId} is closed.`, "UNAVAILABLE");
}

export function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

import type { Platform } from "./chat";

export type SdjfamEvent = {
  id: string;
  platform: Platform | "system";
  event_type: string;

  user: {
    id?: string | null;
    username: string | null;
    display_name: string | null;
  } | null;

  message: string | null;

  amount?: {
    value: number;
    currency: string | null;
  } | null;

  raw_event_type?: string | null;
  metadata?: unknown;
};

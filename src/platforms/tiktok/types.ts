

export type TikTokSidecarPayload = {
  schemaVersion?: number;
  roomId?: string | null;
  eventId?: string;
  receivedAt?: number;
  userId?: string | null;
  totalLikeCount?: number;
  giftType?: number | null;
  repeatEnd?: boolean;
  groupId?: string | null;
  type?: string;
  platform?: string;

  username?: string;
  uniqueId?: string | null;
  message?: string;

  count?: number;

  giftName?: string;
  giftId?: string | number | null;
  repeatCount?: number;
  diamondCount?: number | null;

  eventType?: string;
  status?: string;
};

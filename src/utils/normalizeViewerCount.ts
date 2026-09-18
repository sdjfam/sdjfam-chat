

export function normalizeViewerCount(
  value: number | null
): number | null {
  if(
    typeof value !== "number" ||
    !Number.isFinite(value)
  ) {
    return null;
  }

  return Math.max(
    0,
    Math.trunc(value)
  );
}



export function formatRemainingTime(
  seconds: number
): string {
  if(seconds <= 0) {
    return "verlopen";
  }

  const totalHours =
    Math.floor(seconds / 3600);

  const days =
    Math.floor(totalHours / 24);

  const hours =
    totalHours % 24;

  if(days > 0) {
    return `${days} dagen ${hours} uur`;
  }

  const minutes =
    Math.floor(
      (seconds % 3600) / 60
    );

  if(hours > 0) {
    return `${hours} uur ${minutes} min`;
  }

  return `${Math.max(minutes, 1)} min`;
}

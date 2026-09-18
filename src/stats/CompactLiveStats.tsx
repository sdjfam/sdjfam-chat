import type { PlatformLiveStats } from "./types";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("nl-NL");

export function CompactLiveStats({ stats }: { stats: PlatformLiveStats }) {
  if (!stats.connected) return null;
  const metrics: { key: string; text: string; description: string }[] = [];
  if (stats.totalLikes !== null) metrics.push({
    key: "likes", text: `♥ ${compact.format(stats.totalLikes)}`,
    description: `${full.format(stats.totalLikes)} likes: laatst door TikTok gemeld totaal van deze livestream.`,
  });
  if (stats.giftsObserved !== null) {
    const diamonds = stats.diamondValuesComplete ? stats.diamondsObserved : null;
    metrics.push({ key: "gifts",
      text: diamonds !== null ? `🎁 ${compact.format(diamonds)} ◆` : `🎁 ${compact.format(stats.giftsObserved)}`,
      description: diamonds !== null
        ? `${full.format(diamonds)} diamonds uit ${full.format(stats.giftsObserved)} ontvangen gifts sinds verbinden. Giftwaarde, geen euro-opbrengst.`
        : `${full.format(stats.giftsObserved)} ontvangen gifts sinds verbinden. Diamondwaarde niet volledig beschikbaar.`,
    });
  }
  if (stats.followersObserved !== null) metrics.push({
    key: "followers", text: `+${compact.format(stats.followersObserved)}`,
    description: `${full.format(stats.followersObserved)} nieuwe volgers waargenomen sinds verbinden.`,
  });
  if (metrics.length === 0) return null;
  return (
    <div className="compact-live-stats" aria-label="TikTok live-statistieken">
      {metrics.map(metric => (
        <span className="compact-live-stat" key={metric.key} title={metric.description} aria-label={metric.description}>
          <span aria-hidden="true">{metric.text}</span>
        </span>
      ))}
    </div>
  );
}

import type { SimMetrics } from '../sim/types';

export function MetricsBar({ metrics }: { metrics: SimMetrics }) {
  const items: [string, number | string][] = [
    ['sent', metrics.messagesSent],
    ['delivered', metrics.messagesDelivered],
    ['dropped', metrics.messagesDropped],
    ['timers', metrics.timersFired],
    ['events', metrics.steps],
  ];
  return (
    <div className="metrics-bar">
      {items.map(([k, v]) => (
        <div className="metric" key={k}>
          <span className="metric-val">{v}</span>
          <span className="metric-key">{k}</span>
        </div>
      ))}
    </div>
  );
}

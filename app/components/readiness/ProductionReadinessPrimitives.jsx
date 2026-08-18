import { statusLabel } from "./productionReadinessViewModel.js";

export function Metric({ label, value, compact = false }) {
  return (
    <div className="readiness-metric">
      <p className="readiness-metric__label">{label}</p>
      <p
        className={`readiness-metric__value ${
          compact ? "readiness-metric__value--compact" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

export function Status({ status }) {
  return (
    <span className={`readiness-status readiness-status--${status}`}>
      {statusLabel(status)}
    </span>
  );
}

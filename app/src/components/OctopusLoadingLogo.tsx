import type { CSSProperties } from "react";

const OCTOPUS_LOGO_URL = "./octopus-logo.png";

export function OctopusLoadingLogo({ size = 56 }: { size?: number }) {
  const maskImage = `url(${OCTOPUS_LOGO_URL})`;
  return (
    <span
      aria-hidden="true"
      className="octopus-loading-logo relative inline-flex shrink-0 items-center justify-center"
      style={{
        height: size,
        width: size,
      }}
    >
      <img
        alt=""
        className="octopus-loading-logo-base size-full"
        draggable={false}
        src={OCTOPUS_LOGO_URL}
      />
      <span
        className="octopus-loading-logo-overlay pointer-events-none absolute inset-0"
        style={{
          WebkitMaskImage: maskImage,
          WebkitMaskPosition: "center",
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskSize: "contain",
          maskImage,
          maskPosition: "center",
          maskRepeat: "no-repeat",
          maskSize: "contain",
        } as CSSProperties}
      />
    </span>
  );
}

export function OctopusLoadingState({
  className = "",
  label,
  detail,
  actionLabel,
  onAction,
}: {
  className?: string;
  label: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className={className || undefined}
      role="status"
    >
      <div className="flex flex-col items-center gap-3 px-6 text-center">
        <OctopusLoadingLogo />
        {detail && <span className="max-w-sm text-xs leading-5 text-token-text-secondary">{detail}</span>}
        {actionLabel && onAction && (
          <button
            className="no-drag mt-1 rounded-full bg-token-list-hover-background px-3.5 py-1.5 text-xs text-token-foreground cursor-pointer border-0"
            onClick={onAction}
            type="button"
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

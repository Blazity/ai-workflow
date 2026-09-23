import { integrationManifest } from "@integrations/registry";

import { integrationMonogram } from "@/lib/cockpit/navigation";

/**
 * An integration's mark: the glyph or monogram its own manifest declares, on
 * the colour it declares. Core names no provider, so nothing here knows which
 * integration is which; it asks the registry for the id it was handed.
 *
 * An id this build does not ship (a worker a build ahead) or a manifest with no
 * icon gets the name's initials on a neutral tile rather than a guess.
 *
 * Decorative: the name is always written beside it, so it is hidden from
 * assistive technology rather than read out twice.
 */
export function IntegrationIcon({
  id,
  name,
  size = 32,
  muted = false,
}: {
  id: string;
  name: string;
  /** Edge length in pixels. */
  size?: number;
  /** Switched off: the mark is drawn without its colour. */
  muted?: boolean;
}) {
  const icon = integrationManifest(id)?.icon;
  const radius = Math.max(3, Math.round(size / 6));
  const tile = {
    width: size,
    height: size,
    borderRadius: radius,
    // A brand colour is the integration's own data, not a token of ours.
    backgroundColor: icon?.color,
  };
  const tone = muted ? "grayscale opacity-60" : "";

  if (icon && "glyph" in icon) {
    const inset = Math.round(size * 0.2);
    return (
      <span
        aria-hidden="true"
        data-integration-icon={id}
        className={`inline-flex shrink-0 items-center justify-center ${tone}`}
        style={tile}
      >
        <svg
          viewBox="0 0 24 24"
          width={size - inset * 2}
          height={size - inset * 2}
          fill="#ffffff"
          focusable="false"
        >
          <path d={icon.glyph} />
        </svg>
      </span>
    );
  }

  const letters = icon && "monogram" in icon ? icon.monogram : integrationMonogram(name);
  return (
    <span
      aria-hidden="true"
      data-integration-icon={id}
      className={`inline-flex shrink-0 items-center justify-center font-mono font-semibold leading-none ${
        icon ? "text-white" : "border border-neutral-300 bg-app-bg text-neutral-700"
      } ${tone}`}
      style={{ ...tile, fontSize: Math.max(8, Math.round(size * (letters.length > 1 ? 0.36 : 0.46))) }}
    >
      {letters}
    </span>
  );
}

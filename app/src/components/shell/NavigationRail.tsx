import type { KeyboardEvent } from "react";
import "../icon-glyphs/navigation";
import { OcIconButton } from "../../design-system/components";
import { Glyph } from "../IconGlyphs";
import { clientNavigationDestinations, type ClientNavigationSection } from "../../shell/navigation";
import type { ClientSurfaceDescriptor } from "../../shell/surfaceTypes";
import type { RuntimeHostView } from "../../runtimeHost";
import { AccountRailButton } from "./AccountRailButton";
import { GestureRailIndicator } from "../gestures/GestureRailIndicator";
import { MessageTooltip } from "../chat/MessageTooltip";

export function NavigationRail({
  disabled = false,
  labeledDrawer = false,
  accessProfile,
  activeSection,
  surfaces,
  unreadCount,
  arrivalId,
  runtimeHost,
  onNavigate,
  onOpenSettings,
  onLogOut,
}: {
  disabled?: boolean;
  labeledDrawer?: boolean;
  accessProfile: "live" | "lab";
  activeSection: ClientNavigationSection;
  surfaces: readonly ClientSurfaceDescriptor[];
  unreadCount: number;
  arrivalId?: string;
  runtimeHost: RuntimeHostView;
  onNavigate: (section: ClientNavigationSection) => void;
  onOpenSettings: (section?: string) => void;
  onLogOut: () => void;
}) {
  return (
    <nav className={`navigation-rail${labeledDrawer ? " is-labeled-drawer" : ""}`} aria-hidden={disabled || undefined} inert={disabled || undefined} aria-label="App navigation" data-app-navigation-rail="true" onKeyDown={moveRailFocus}>
      <div className="navigation-rail-destinations">
        {clientNavigationDestinations.filter((destination) => surfaces.some((surface) => surface.id === destination.surfaceId)).map((destination) => (
          <div className="navigation-rail-item" key={destination.id}>
            {labeledDrawer ? (
              <button
                aria-current={destination.id === activeSection ? "page" : undefined}
                className={`navigation-drawer-item${destination.id === activeSection ? " is-active" : ""}`}
                data-navigation-destination={destination.id}
                onClick={() => onNavigate(destination.id)}
                type="button"
              >
                <span aria-hidden="true" className="navigation-drawer-item-icon">
                  <Glyph name={destination.id === activeSection ? destination.selectedGlyph : destination.glyph} size={18} />
                </span>
                <span>{destination.label}</span>
                {destination.id === "inbox" && unreadCount > 0 ? <em className="navigation-drawer-badge">{unreadCount}</em> : null}
              </button>
            ) : (
              <>
                <MessageTooltip label={destination.label} side="right" delayMs={300}>
                  <OcIconButton
                    appearance="rail"
                    aria-current={destination.id === activeSection ? "page" : undefined}
                    data-navigation-destination={destination.id}
                    glyph={destination.id === activeSection ? destination.selectedGlyph : destination.glyph}
                    label={destination.id === "inbox" && unreadCount > 0 ? `Inbox, ${unreadCount} unread` : destination.label}
                    onClick={() => onNavigate(destination.id)}
                    selected={destination.id === activeSection}
                    title=""
                  />
                </MessageTooltip>
                {destination.id === "inbox" && unreadCount > 0 ? <span className="navigation-rail-unread" aria-hidden="true" /> : null}
                {destination.id === "inbox" && unreadCount > 0 && arrivalId ? <span className="navigation-rail-arrival" key={arrivalId} aria-hidden="true" /> : null}
              </>
            )}
          </div>
        ))}
      </div>
      <GestureRailIndicator accessProfile={accessProfile} onOpenSettings={() => onOpenSettings("gestures")} />
      <AccountRailButton accessProfile={accessProfile} runtimeHost={runtimeHost} onLogOut={onLogOut} onOpenSettings={onOpenSettings} />
    </nav>
  );
}

function moveRailFocus(event: KeyboardEvent<HTMLElement>): void {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || !(event.target instanceof HTMLButtonElement)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  const index = buttons.indexOf(event.target);
  if (index < 0 || !buttons.length) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus();
}

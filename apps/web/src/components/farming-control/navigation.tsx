import { useLingui } from "@lingui/react/macro";
import type { FarmingControlSection } from "@rakazo/contracts";
import { ChartNoAxesCombined, Coins, Receipt, ShieldAlert } from "lucide-react";
import { Link } from "react-router-dom";

export function FarmingControlNavigation({
  active,
  mini,
  onNavigate,
}: {
  active: FarmingControlSection | null;
  mini: boolean;
  onNavigate: () => void;
}) {
  const { t } = useLingui();
  const pages = [
    { id: "portfolio", title: t`Portfolio`, Icon: ChartNoAxesCombined },
    { id: "harvest", title: t`Harvest`, Icon: Coins },
    { id: "risk", title: t`Risk`, Icon: ShieldAlert },
    { id: "accounting", title: t`Accounting`, Icon: Receipt },
  ] as const;
  return (
    <nav aria-label={t`Farming Control`} className="mb-3 space-y-0.5">
      {!mini ? (
        <div className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground">{t`Farming Control`}</div>
      ) : null}
      {pages.map(({ id, title, Icon }) => (
        <Link
          key={id}
          to={`/app/farming/${id}`}
          onClick={onNavigate}
          aria-label={mini ? title : undefined}
          aria-current={active === id ? "page" : undefined}
          title={mini ? title : undefined}
          className={`flex items-center gap-3 rounded-xl py-2.5 text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring ${mini ? "justify-center px-0" : "px-2.5"} ${active === id ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-sidebar-foreground"}`}
        >
          <Icon size={17} strokeWidth={1.7} aria-hidden="true" />
          {!mini ? <span>{title}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

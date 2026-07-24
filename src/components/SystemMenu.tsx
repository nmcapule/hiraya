import { BookOpenText, GearSix, IdentificationCard, Keyboard, ShareNetwork, SignOut, SquaresFour, Trash, UserCircle } from "@phosphor-icons/react";
import type { AuthSession } from "../lib/auth";
import { SERVER_ROUTES } from "../lib/api-routes";
import { MobileHeaderMenu } from "./MobileHeaderMenu";

type Props = {
  session: AuthSession | null;
  canOpenTrash: boolean;
  canShare: boolean;
  onWorkspace: () => void;
  onSettings: () => void;
  onHelp: () => void;
  onShortcuts: () => void;
  onTrash: () => void;
  onShare: () => void;
};

export function SystemMenu({ session, canOpenTrash, canShare, onWorkspace, onSettings, onHelp, onShortcuts, onTrash, onShare }: Props) {
  return <MobileHeaderMenu label={session ? `Account and system: ${session.user.displayName}` : "System menu"} icon={session ? <UserCircle size={18} /> : <GearSix size={18} />}>
    {(dismiss) => <>
      {session && <div className="account-menu__identity"><strong>{session.user.displayName}</strong>{session.user.email && <span>{session.user.email}</span>}</div>}
      <button type="button" onClick={() => { dismiss(); onWorkspace(); }}><SquaresFour /> Workspace Overview</button>
      <button type="button" onClick={() => { dismiss(); onSettings(); }}><GearSix /> Settings</button>
      <button type="button" onClick={() => { dismiss(); onHelp(); }}><BookOpenText /> Help</button>
      <button type="button" onClick={() => { dismiss(); onShortcuts(); }}><Keyboard /> Keyboard shortcuts</button>
      {canOpenTrash && <button type="button" onClick={() => { dismiss(); onTrash(); }}><Trash /> Trash</button>}
      {canShare && <button type="button" onClick={() => { dismiss(); onShare(); }}><ShareNetwork /> Share workspace</button>}
      {session && <><span className="mobile-header-menu__separator" /><a className="account-menu__action" href={SERVER_ROUTES.profile} onClick={dismiss}><IdentificationCard /> Profile</a><form action={SERVER_ROUTES.logout} method="post"><button className="account-menu__action" type="submit"><SignOut /> Log out</button></form></>}
    </>}
  </MobileHeaderMenu>;
}

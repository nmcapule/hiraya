import { IdentificationCard, SignOut, UserCircle } from "@phosphor-icons/react";
import type { AuthSession } from "../lib/auth";
import { SERVER_ROUTES } from "../lib/api-routes";
import { MobileHeaderMenu } from "./MobileHeaderMenu";

export function AccountMenu({ session }: { session: AuthSession }) {
  return (
    <MobileHeaderMenu label={`Account: ${session.user.displayName}`} icon={<UserCircle size={17} />}>
      {(dismiss) => <>
        <div className="account-menu__identity">
          <strong>{session.user.displayName}</strong>
          {session.user.email && <span>{session.user.email}</span>}
        </div>
        <a className="account-menu__action" href={SERVER_ROUTES.profile} onClick={dismiss}><IdentificationCard size={17} /> Profile</a>
        <form action={SERVER_ROUTES.logout} method="post">
          <button className="account-menu__action" type="submit"><SignOut size={17} /> Log out</button>
        </form>
      </>}
    </MobileHeaderMenu>
  );
}

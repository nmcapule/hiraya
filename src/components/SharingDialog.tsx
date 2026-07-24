import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Check, Copy, Globe, LinkSimple, Plus, Trash, UsersThree, X } from "@phosphor-icons/react";
import { getSharing, inviteMember, publishDesktop, removeMember, revokeInvitation, rotatePublication, unpublishDesktop, updateMember, type SharingRole, type SharingState } from "../lib/sharing";
import type { DesktopIdentity } from "../types";
import { useModalDialog } from "../ui/modal-dialog";

const ROLES: SharingRole[] = ["reader", "writer", "manager"];

function publicUrl(publication: SharingState["publication"]) {
  if (publication.url) return new URL(publication.url, window.location.href).href;
  return publication.token ? new URL(`/shared/${encodeURIComponent(publication.token)}`, window.location.origin).href : "";
}

export function SharingDialog({ desktop, onClose }: { desktop: DesktopIdentity; onClose: () => void }) {
  const [sharing, setSharing] = useState<SharingState | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<SharingRole>("reader");
  const [expiryHours, setExpiryHours] = useState(168);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [lastInvite, setLastInvite] = useState<{ url?: string; invitationUrl?: string; token?: string } | null>(null);
  const [copied, setCopied] = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useModalDialog(backdropRef, dialogRef, onClose, busy !== "");

  async function refresh() { setSharing(await getSharing(desktop.id)); }
  useEffect(() => { void getSharing(desktop.id).then(setSharing).catch((reason) => setError(reason instanceof Error ? reason.message : "Sharing could not be loaded.")); }, [desktop.id]);
  async function run(key: string, operation: () => Promise<unknown>) {
    setBusy(key); setError("");
    try { await operation(); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The sharing change could not be saved."); }
    finally { setBusy(""); }
  }
  async function revealPublication(key: string, operation: () => Promise<unknown>) {
    setBusy(key); setError("");
    try {
      const result = await operation();
      const refreshed = await getSharing(desktop.id);
      if (result && typeof result === "object") {
        const revealed = result as { url?: unknown; token?: unknown };
        refreshed.publication = {
          ...refreshed.publication,
          ...(typeof revealed.url === "string" ? { url: revealed.url } : {}),
          ...(typeof revealed.token === "string" ? { token: revealed.token } : {}),
        };
      }
      setSharing(refreshed);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The public link could not be changed."); }
    finally { setBusy(""); }
  }
  async function copy(value: string, key: string) { await navigator.clipboard.writeText(value); setCopied(key); window.setTimeout(() => setCopied(""), 1800); }
  const publicationUrl = sharing ? publicUrl(sharing.publication) : "";

  return <div ref={backdropRef} className="sharing-dialog__backdrop" role="presentation" onPointerDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="sharing-dialog" role="dialog" aria-modal="true" aria-labelledby="sharing-title" tabIndex={-1} aria-busy={busy !== "" || undefined}>
      <header><div><span className="window-kicker">Access and publication</span><h2 id="sharing-title">Share {desktop.name}</h2></div><button className="icon-button" type="button" disabled={busy !== ""} onClick={onClose} aria-label="Close sharing"><X size={18} /></button></header>
      <div className="sharing-dialog__content">
        <section className="sharing-section"><div className="sharing-section__heading"><UsersThree size={20} /><div><h3>People with access</h3><p>Managers can share and customize. Writers can organize and edit files.</p></div></div>
            <form className="sharing-invite" onSubmit={(event) => { event.preventDefault(); void run("invite", async () => { const result = await inviteMember(desktop.id, { email: email.trim(), role, expiryHours }); if (result && typeof result === "object") setLastInvite(result as { url?: string; invitationUrl?: string; token?: string }); setEmail(""); }); }}>
            <label><span>Email address</span><input type="email" required value={email} placeholder="person@example.com" onChange={(event) => setEmail(event.target.value)} /></label>
            <label><span>Role</span><select value={role} onChange={(event) => setRole(event.target.value as SharingRole)}>{ROLES.map((value) => <option value={value} key={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
            <label><span>Expires</span><select value={expiryHours} onChange={(event) => setExpiryHours(Number(event.target.value))}><option value={24}>1 day</option><option value={168}>7 days</option><option value={720}>30 days</option></select></label>
            <button className="button button--primary" type="submit" disabled={busy !== "" || !email.trim()}><Plus size={16} /> Invite</button>
          </form>
          {lastInvite && (lastInvite.invitationUrl || lastInvite.url || lastInvite.token) && <div className="sharing-token"><div><strong>Invitation ready</strong><span>{lastInvite.invitationUrl || lastInvite.url || lastInvite.token}</span></div><button className="button button--quiet" type="button" onClick={() => void copy(lastInvite.invitationUrl || lastInvite.url || lastInvite.token || "", "invite")}>{copied === "invite" ? <Check size={15} /> : <Copy size={15} />} {copied === "invite" ? "Copied" : "Copy"}</button></div>}
          {!sharing ? <div className="sharing-loading">Loading people...</div> : <div className="sharing-members">
            {sharing.members.map((member) => <div className="sharing-member" key={member.userId}><span className="sharing-avatar">{member.avatar && !member.avatar.startsWith("identicon:") ? <img src={member.avatar} alt="" /> : member.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{member.displayName}</strong><span>{member.email || (member.role === "owner" ? "Desktop owner" : "Member")}</span></div>{member.role === "owner" ? <span className="role-badge">Owner</span> : <><select aria-label={`Role for ${member.displayName}`} value={member.role} disabled={busy !== ""} onChange={(event) => void run(`member-${member.userId}`, () => updateMember(desktop.id, member.userId, event.target.value as SharingRole))}>{ROLES.map((value) => <option value={value} key={value}>{value}</option>)}</select><button className="icon-button sharing-member__remove" type="button" disabled={busy !== ""} onClick={() => void run(`member-${member.userId}`, () => removeMember(desktop.id, member.userId))} aria-label={`Remove ${member.displayName}`}><Trash size={16} /></button></> }</div>)}
            {sharing.pending.map((invite) => <div className="sharing-member sharing-member--pending" key={invite.id}><span className="sharing-avatar"><LinkSimple size={16} /></span><div><strong>{invite.email}</strong><span>Invitation pending · {invite.role}</span>{(invite.url || invite.token) && <code>{invite.url || invite.token}</code>}</div>{(invite.url || invite.token) && <button className="icon-button" type="button" onClick={() => void copy(invite.url || invite.token || "", invite.id)} aria-label={`Copy invitation for ${invite.email}`}>{copied === invite.id ? <Check size={16} /> : <Copy size={16} />}</button>}<button className="icon-button sharing-member__remove" type="button" disabled={busy !== ""} onClick={() => void run(`invite-${invite.id}`, () => revokeInvitation(desktop.id, invite.email))} aria-label={`Revoke invitation for ${invite.email}`}><Trash size={16} /></button></div>)}
          </div>}
        </section>
        <section className="sharing-section"><div className="sharing-section__heading"><Globe size={20} /><div><h3>Public link</h3><p>Anyone with this opaque link can browse and download a read-only copy.</p></div></div>
          {sharing?.publication.published ? <div className="publication-card"><div><span>Published</span><strong>{publicationUrl || "Rotate the link to reveal a new share URL."}</strong></div>{publicationUrl && <button className="button button--quiet" type="button" onClick={() => void copy(publicationUrl, "public")}>{copied === "public" ? <Check size={15} /> : <Copy size={15} />} {copied === "public" ? "Copied" : "Copy link"}</button>}<button className="button button--quiet" type="button" disabled={busy !== ""} onClick={() => void revealPublication("rotate", () => rotatePublication(desktop.id))}><ArrowClockwise size={15} /> Rotate</button><button className="button button--danger" type="button" disabled={busy !== ""} onClick={() => void run("unpublish", () => unpublishDesktop(desktop.id))}>Unpublish</button></div> : <button className="button button--primary" type="button" disabled={!sharing || busy !== ""} onClick={() => void revealPublication("publish", () => publishDesktop(desktop.id))}><Globe size={16} /> Publish read-only link</button>}
        </section>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </section>
  </div>;
}

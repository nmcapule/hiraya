import { useRef } from "react";
import { CloudCheck, DownloadSimple, HardDrive, MapTrifold, ShieldWarning, X } from "@phosphor-icons/react";
import { useModalDialog } from "../ui/modal-dialog";
import type { PwaInstallState } from "../lib/pwa-install";

type Props = { local: boolean; installState: PwaInstallState; onInstall: () => void; onClose: () => void };

export function GettingStartedDialog({ local, installState, onInstall, onClose }: Props) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useModalDialog(backdropRef, dialogRef, onClose);
  return <div ref={backdropRef} className="modal-backdrop onboarding-backdrop" role="presentation">
    <section ref={dialogRef} className="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="getting-started-title" tabIndex={-1}>
      <header><div><span className="window-kicker">Getting started</span><h2 id="getting-started-title">Know where your work lives</h2></div><button className="icon-button" type="button" aria-label="Close Getting Started" onClick={onClose}><X size={18} /></button></header>
      <div className="onboarding-dialog__grid">
        <article>{local ? <HardDrive size={22} /> : <CloudCheck size={22} />}<div><h3>{local ? "Saved in this browser" : "Synchronized storage"}</h3><p>{local ? "This browser is authoritative. Clearing site data removes Hiraya files, so export regularly." : "The server is authoritative. Cached files and queued changes support offline work; shared desktop editing may require a connection."}</p></div></article>
        <article><ShieldWarning size={22} /><div><h3>Export is not operator backup</h3><p>A desktop export is a portable package of saved items. Server operators still need consistent database and blob backups for full recovery.</p></div></article>
        <article><MapTrifold size={22} /><div><h3>Desktop areas are derived</h3><p>Dragging icons beyond an edge creates another view of one continuous desktop. Areas are derived from positions, not separate folders.</p></div></article>
        <article><DownloadSimple size={22} /><div><h3>Install Hiraya</h3><p>{installState === "standalone" || installState === "installed" ? "Hiraya is installed on this device." : installState === "promptable" ? "Install for an app-like window and quick launch." : "Use your browser's Install app or Add to Home Screen menu when available."}</p>{installState === "promptable" && <button className="button button--quiet" type="button" onClick={onInstall}>Install app</button>}</div></article>
      </div>
      <footer><span>You can revisit this guide from Settings.</span><button className="button button--primary" type="button" autoFocus onClick={onClose}>Open desktop</button></footer>
    </section>
  </div>;
}

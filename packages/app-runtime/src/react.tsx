import { useEffect, useRef } from "react";
import type { AppPackageInspection } from "@hiraya/app-cli";
import { RpcDispatcher } from "./dispatcher";
import { initializeSandboxFrame, materializeAppPackage } from "./sandbox";

export function SandboxAppFrame({ package: appPackage, dispatcher, title }: { package: AppPackageInspection; dispatcher: RpcDispatcher; title: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const materialized = materializeAppPackage(appPackage);
    const frame = frameRef.current;
    if (!frame) { materialized.revoke(); return; }
    const dispose = initializeSandboxFrame(frame, appPackage.manifest.id, dispatcher);
    frame.src = materialized.url;
    return () => { dispose(); frame.removeAttribute("src"); materialized.revoke(); };
  }, [appPackage, dispatcher]);
  return <iframe ref={frameRef} className="sandbox-app-frame" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="" />;
}
